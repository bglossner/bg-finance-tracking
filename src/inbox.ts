import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { StartingBalanceError, type ImportResult, type ImportRow, type StatementBalance, type StatementImport } from './actual.js';
import { InvalidStatement } from './importers/actual-file-parser.js';
import { matchStatement, parseAccounts, parseStatement, readStatementBalance } from './importers/chase.js';
import { nextExportWindow } from './state/export-window.js';
import {
  createDataRoot, isMissing, loadAccounts, privateDirectory, saveAccounts, syncDirectory, withIntakeLock, type AccountState,
} from './state/intake-state.js';

type Routes = ReturnType<typeof parseAccounts>;
interface ImportOptions {
  dataRoot: string;
  repository: string;
  routes: Routes;
  cutoff: string;
  budgetIdentity: string;
  now?: Date;
  report: (message: string) => void;
  warn: (message: string) => void;
  showBalanceDifference?: boolean;
  importRows: (account: string, rows: ImportRow[], statement: StatementImport) => Promise<ImportResult>;
  setStartingBalance?: string;
}

interface Options extends ImportOptions {
  minimumAgeSeconds: number;
  staleDays: number;
  acceptedExtensions?: readonly string[];
  parseRows?: typeof parseStatement;
}

interface Candidate {
  path: string;
  info: Stats;
  alias?: string;
}

interface StatementJob {
  alias: string;
  hash: string;
  rows: ImportRow[];
  extension: string;
  balance?: StatementBalance;
}

type Job = Candidate & StatementJob & {
  earliest?: string;
  latest?: string;
};

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function unchanged(candidate: Candidate): Promise<boolean> {
  return lstat(candidate.path).then(info => sameFile(candidate.info, info), error => {
    if (isMissing(error)) return false;
    throw error;
  });
}

async function snapshot(candidate: Candidate): Promise<Buffer | undefined> {
  const file = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || !sameFile(candidate.info, before)) return undefined;
    const contents = await file.readFile();
    if (sameFile(before, await file.stat()) && await unchanged(candidate)) return contents;
  } finally {
    await file.close();
  }
}

const safeAlias = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const temporarySuffix = /\.(crdownload|part|download|tmp)$/i;

async function claimInbox(inbox: string, processing: string, cutoff: number, warn: () => void, alias?: string): Promise<void> {
  const directory = await open(inbox, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const source = `/proc/self/fd/${directory.fd}`;
  try {
    const info = await directory.stat();
    if (info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Inbox directory is not private.');
    const canonical = await realpath(source);
    for (const name of (await readdir(source)).sort()) {
      if (name === '.processing' || temporarySuffix.test(name)) continue;
      const path = join(source, name);
      try {
        const info = await lstat(path);
        if (info.isDirectory()) {
          if (alias === undefined && safeAlias.test(name)) await claimInbox(path, processing, cutoff, warn, name);
        } else if (info.mtimeMs <= cutoff) {
          // Claim before reading so an atomic producer drop with the same
          // basename can only replace the inbox entry, never the claimed file.
          if (await realpath(source) !== canonical) throw new Error('Inbox directory moved.');
          const claimed = await mkdtemp(join(processing, `${alias ?? '_'}.`));
          await syncDirectory(processing);
          try {
            await rename(path, join(claimed, name));
          } catch (error) {
            await rmdir(claimed);
            throw error;
          }
          await syncDirectory(claimed);
          await directory.sync();
        }
      } catch (error) {
        if (!isMissing(error)) warn();
      }
    }
  } finally {
    await directory.close();
  }
}

async function* claimedFiles(processing: string, cutoff: number, warn: () => void): AsyncGenerator<Candidate> {
  for (const name of (await readdir(processing)).sort()) {
    try {
      const route = /^(?:_|([a-zA-Z0-9][a-zA-Z0-9_-]*))\.[a-zA-Z0-9]{6}$/.exec(name);
      if (!route) throw new Error('Invalid claimed job directory.');
      const directory = await privateDirectory(join(processing, name));
      const files = await readdir(directory);
      if (!files.length) {
        await rmdir(directory);
        continue;
      }
      if (files.length !== 1) throw new Error('Invalid claimed job contents.');
      const path = join(directory, files[0]);
      const info = await lstat(path);
      if (info.mtimeMs <= cutoff) yield { path, info, alias: route[1] };
    } catch {
      warn();
    }
  }
}

async function destination(directory: string, candidate: Candidate, kind = ''): Promise<string> {
  // A private tree and the intake lock exclude other importers. Bound the
  // preserved basename so even a maximum-length input leaves room for a reason.
  const name = [...basename(candidate.path)].slice(0, 45).join('');
  for (;;) {
    const target = join(directory, `${randomUUID()}${kind}-${name}`);
    const available = await lstat(target).then(() => false, error => {
      if (isMissing(error)) return true;
      throw error;
    });
    if (available) return target;
  }
}

async function finishMove(candidate: Candidate, directory: string): Promise<void> {
  await syncDirectory(directory);
  const claimed = dirname(candidate.path);
  await syncDirectory(claimed);
  await rmdir(claimed);
  await syncDirectory(dirname(claimed));
}

async function move(candidate: Candidate, target: string): Promise<void> {
  if (!await unchanged(candidate)) throw new Error('Statement changed during intake.');
  await rename(candidate.path, target);
  await finishMove(candidate, dirname(target));
}

async function quarantine(directory: string, candidate: Candidate, reason: string): Promise<void> {
  const target = await destination(directory, candidate);
  const note = `${target}.reason.txt`;
  const explanation = await open(note, 'wx', 0o600);
  try {
    try {
      await explanation.writeFile(`${reason}\n`);
      await explanation.sync();
    } finally {
      await explanation.close();
    }
    if (!await unchanged(candidate)) throw new Error('Statement changed during intake.');
    await rename(candidate.path, target);
  } catch (error) {
    await unlink(note);
    throw error;
  }
  await finishMove(candidate, directory);
}

function dates(rows: ImportRow[]) {
  let earliest: string | undefined;
  let latest: string | undefined;
  for (const { postedDate } of rows) {
    if (!earliest || postedDate < earliest) earliest = postedDate;
    if (!latest || postedDate > latest) latest = postedDate;
  }
  return { earliest, latest };
}

async function prepare(candidate: Candidate, options: Options, blocked: Set<string>): Promise<Job | string> {
  if (candidate.info.isSymbolicLink()) return 'Symbolic links are not accepted.';
  if (!candidate.info.isFile() || candidate.info.nlink !== 1) return 'Expected a standalone regular file.';
  const extension = extname(candidate.path).toLowerCase();
  if (!(options.acceptedExtensions ?? ['.qfx', '.ofx', '.csv']).includes(extension)) return 'Unsupported file extension.';
  let contents: Buffer;
  try {
    const copy = await snapshot(candidate);
    if (!copy) throw new Error('Claimed file changed.');
    contents = copy;
  } catch (error) {
    if (candidate.alias !== undefined) blocked.add(candidate.alias);
    throw error;
  }
  let alias: string;
  try {
    alias = matchStatement(options.routes, candidate.path, contents, candidate.alias);
  } catch (error) {
    // Matcher messages are fixed strings and contain no statement values.
    return error instanceof Error ? error.message : 'Statement could not be routed.';
  }
  let rows: ImportRow[];
  try {
    rows = await (options.parseRows ?? parseStatement)(contents, extension);
  } catch (error) {
    if (error instanceof InvalidStatement) return 'Invalid Chase statement.';
    blocked.add(alias);
    throw error;
  }
  return {
    ...candidate, alias, rows, extension, ...dates(rows), balance: readStatementBalance(contents, extension),
    hash: createHash('sha256').update(contents).digest('hex'),
  };
}

async function withAccounts<T>(options: ImportOptions, run: (
  context: { root: string; state: string; accounts: Map<string, AccountState>; identities: Map<string, string>; now: Date },
) => Promise<T>): Promise<T> {
  if (!options.routes.size || [...options.routes.keys()].some(alias => !safeAlias.test(alias))) {
    throw new Error('Configure at least one alias using letters, digits, underscores or hyphens.');
  }
  if (options.setStartingBalance !== undefined && !options.routes.has(options.setStartingBalance)) {
    throw new Error('Unknown account alias for --set-starting-balance.');
  }
  const now = options.now ?? new Date();
  const root = await createDataRoot(options.dataRoot, options.repository);
  const state = await privateDirectory(join(root, 'state'));
  return withIntakeLock(state, async () => {
    const accounts = await loadAccounts(state, options.warn);
    const identities = new Map([...options.routes].map(([alias, route]) => [alias,
      createHash('sha256').update(JSON.stringify([options.budgetIdentity, route.actualAccount, route.last4])).digest('hex'),
    ]));
    for (const [alias, identity] of identities) {
      const saved = accounts.get(alias);
      if (saved && saved.identity !== identity) throw new Error('An account destination changed. Use a separate intake data root.');
    }
    return run({ root, state, accounts, identities, now });
  });
}

function signedAmount(cents: bigint): string {
  const value = (cents < 0n ? -cents : cents).toString().padStart(3, '0');
  return `${cents < 0n ? '-' : '+'}${value.slice(0, -2)}.${value.slice(-2)}`;
}

function reportBalance(options: ImportOptions, job: StatementJob, result: ImportResult): void {
  const { alias, extension } = job;
  const check = result.balanceCheck;
  if (check?.difference === 0n) options.report(`${alias}: balance check: matches as of ${check.date}`);
  else if (check) {
    const status = options.showBalanceDifference ? `off by ${signedAmount(check.difference)}` : 'mismatch';
    options.report(`${alias}: balance check: ${status} as of ${check.date}`);
    options.report(`${alias}: to rebase, use --set-starting-balance ${alias} with a fresh QFX or OFX.`);
  } else {
    options.report(`${alias}: balance check: skipped (${extension === '.csv' ? 'CSV has no statement balance' : 'no valid LEDGERBAL'}).`);
  }
}

async function importJob(
  options: ImportOptions, job: StatementJob, forced: boolean, previous: AccountState | undefined,
  identity: string, now: Date, save: (checkpoint: AccountState) => Promise<void>,
): Promise<{ result: ImportResult; duplicate: boolean }> {
  const duplicate = previous?.importedHashes.includes(job.hash) ?? false;
  const result = duplicate && !job.balance ? { added: 0, updated: 0 } :
    await options.importRows(options.routes.get(job.alias)!.actualAccount, job.rows, {
      balance: job.balance, cutoff: options.cutoff, setStartingBalance: Boolean(job.balance && (!previous || forced)),
      skipTransactions: duplicate,
    });
  const check = result.balanceCheck;
  if (!duplicate || check) {
    const latest = dates(job.rows).latest;
    const latestPostedDate = [previous?.latestPostedDate, latest].filter(Boolean).sort().at(-1);
    await save({
      identity, latestPostedDate: duplicate ? previous?.latestPostedDate : latestPostedDate,
      lastRun: duplicate ? previous!.lastRun : now.toISOString(),
      importedHashes: duplicate ? previous!.importedHashes : [...previous?.importedHashes ?? [], job.hash],
      lastBalanceCheck: check ? { date: check.date, status: check.difference === 0n ? 'ok' : 'mismatch' } : previous?.lastBalanceCheck,
    });
  }
  reportBalance(options, job, result);
  return { result, duplicate };
}

async function saveCheckpoint(state: string, accounts: Map<string, AccountState>, alias: string, checkpoint: AccountState) {
  const next = new Map(accounts).set(alias, checkpoint);
  await saveAccounts(state, next);
  accounts.set(alias, checkpoint);
}

export async function runSingleStatement(options: ImportOptions, job: StatementJob): Promise<ImportResult> {
  return withAccounts(options, async ({ state, accounts, identities, now }) => {
    const forced = options.setStartingBalance !== undefined;
    if (forced && (options.setStartingBalance !== job.alias || !job.balance)) {
      throw new Error('Supply a statement with valid LEDGERBAL for the selected alias.');
    }
    const { result } = await importJob(options, job, forced, accounts.get(job.alias), identities.get(job.alias)!, now,
      checkpoint => saveCheckpoint(state, accounts, job.alias, checkpoint));
    return result;
  });
}

export async function runInbox(options: Options): Promise<boolean> {
  return withAccounts(options, async ({ root, state, accounts: initialAccounts, identities, now }) => {
    let accounts = initialAccounts;
    const inbox = await privateDirectory(join(root, 'inbox'));
    const processing = await privateDirectory(join(inbox, '.processing'));
    const archive = await privateDirectory(join(root, 'archive'));
    const rejected = await privateDirectory(join(root, 'quarantine'));
    const intakeDevice = (await stat(processing)).dev;
    if ((await stat(archive)).dev !== intakeDevice || (await stat(rejected)).dev !== intakeDevice) {
      throw new Error('Inbox, archive and quarantine must be on the same filesystem.');
    }
    const jobs: Job[] = [];
    const blocked = new Set<string>();
    let success = true;
    let stateAvailable = true;
    function scanFailed() {
      options.warn('Inbox directory could not be scanned. Check its ownership and permissions.');
      success = false;
    }
    const cutoff = now.getTime() - options.minimumAgeSeconds * 1000;
    await claimInbox(inbox, processing, cutoff, scanFailed);
    for await (const candidate of claimedFiles(processing, cutoff, scanFailed)) {
      try {
        const job = await prepare(candidate, options, blocked);
        if (typeof job === 'string') await quarantine(rejected, candidate, job);
        else jobs.push(job);
      } catch {
        options.warn('A file could not be prepared and remains pending. Check file permissions and statement parser availability.');
        success = false;
      }
    }
    jobs.sort((a, b) => (a.earliest ?? '').localeCompare(b.earliest ?? '') || (a.latest ?? '').localeCompare(b.latest ?? ''));
    for (const alias of options.routes.keys()) {
      let files = 0;
      let duplicates = 0;
      let added = 0;
      let updated = 0;
      let skipped = 0;
      const accountJobs = jobs.filter(job => job.alias === alias && !blocked.has(alias) && stateAvailable);
      let forced: Job | undefined;
      if (options.setStartingBalance === alias) {
        for (const job of accountJobs) {
          if (job.balance && (!forced || job.balance.date >= forced.balance!.date)) forced = job;
        }
        if (forced) {
          // Calculate from the newest ledger snapshot after importing the other files.
          accountJobs.splice(accountJobs.indexOf(forced), 1);
          accountJobs.push(forced);
        } else {
          options.warn(`${alias}: starting balance was not set. Drop a completed QFX or OFX with valid LEDGERBAL and retry.`);
          success = false;
        }
      }
      for (const job of accountJobs) {
        try {
          if (!await unchanged(job)) throw new Error('Claimed file changed.');
          const year = (job.latest ?? now.toISOString()).slice(0, 4);
          const accountArchive = await privateDirectory(join(archive, alias));
          const annualArchive = await privateDirectory(join(accountArchive, year));
          if ((await stat(annualArchive)).dev !== intakeDevice) throw new Error('Archive crosses filesystems.');
          const { result, duplicate } = await importJob(options, job, job === forced, accounts.get(alias), identities.get(alias)!, now,
            checkpoint => saveCheckpoint(state, accounts, alias, checkpoint).catch(async error => {
              // A directory fsync can fail after rename. Re-read the installed
              // state before another account writes a replacement.
              stateAvailable = false;
              accounts = await loadAccounts(state, options.warn);
              stateAvailable = true;
              throw error;
            }));
          if (duplicate) duplicates++;
          added += result.added;
          updated += result.updated;
          skipped += Math.max(0, job.rows.length - result.added - result.updated);
          await move(job, await destination(annualArchive, job, duplicate ? '-duplicate' : ''));
          files++;
        } catch (error) {
          options.warn(`${alias}: ${error instanceof StartingBalanceError ? error.message :
            'intake failed. Check the budget connection and data directories before retrying.'}`);
          success = false;
          break;
        }
      }
      const latest = accounts.get(alias)?.latestPostedDate;
      const next = nextExportWindow(latest).from ?? options.cutoff;
      options.report(`${alias}: ${files} files processed (${duplicates} duplicates), ${added} added, ${updated} updated, ${skipped} skipped, latest posted: ${latest ?? 'none'}, next export from: ${next}`);
      if (!latest || Date.parse(latest) < Date.parse(now.toISOString().slice(0, 10)) - options.staleDays * 86_400_000) {
        options.warn(`${alias}: account is stale.`);
      }
    }
    return success;
  });
}
