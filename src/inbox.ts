import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { ImportRow } from './actual.js';
import { InvalidStatement } from './importers/actual-file-parser.js';
import { matchStatement, parseAccounts, parseStatement } from './importers/chase.js';
import { nextExportWindow } from './state/export-window.js';
import {
  createDataRoot, isMissing, loadAccounts, privateDirectory, saveAccounts, syncDirectory, withIntakeLock,
} from './state/intake-state.js';

type Routes = ReturnType<typeof parseAccounts>;
type Import = (account: string, rows: ImportRow[]) => Promise<{ added: number; updated: number }>;

interface Options {
  dataRoot: string;
  repository: string;
  routes: Routes;
  cutoff: string;
  budgetIdentity: string;
  minimumAgeSeconds: number;
  staleDays: number;
  acceptedExtensions?: readonly string[];
  now?: Date;
  report: (message: string) => void;
  warn: (message: string) => void;
  importRows: Import;
  parseRows?: typeof parseStatement;
}

interface Candidate {
  path: string;
  info: Stats;
  alias?: string;
}

interface Job extends Candidate {
  alias: string;
  hash: string;
  rows: ImportRow[];
  earliest?: string;
  latest?: string;
}

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
    ...candidate, alias, rows, ...dates(rows),
    hash: createHash('sha256').update(contents).digest('hex'),
  };
}

export async function runInbox(options: Options): Promise<boolean> {
  if (!options.routes.size || [...options.routes.keys()].some(alias => !safeAlias.test(alias))) {
    throw new Error('Configure at least one alias using letters, digits, underscores or hyphens.');
  }
  const now = options.now ?? new Date();
  const root = await createDataRoot(options.dataRoot, options.repository);
  const state = await privateDirectory(join(root, 'state'));
  return withIntakeLock(state, async () => {
    const inbox = await privateDirectory(join(root, 'inbox'));
    const processing = await privateDirectory(join(inbox, '.processing'));
    const archive = await privateDirectory(join(root, 'archive'));
    const rejected = await privateDirectory(join(root, 'quarantine'));
    let accounts = await loadAccounts(state, options.warn);
    const identities = new Map([...options.routes].map(([alias, route]) => [alias,
      createHash('sha256').update(JSON.stringify([options.budgetIdentity, route.actualAccount, route.last4])).digest('hex'),
    ]));
    for (const [alias, identity] of identities) {
      const saved = accounts.get(alias);
      if (saved && saved.identity !== identity) throw new Error('An account destination changed. Use a separate intake data root.');
    }
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
    for (const [alias, route] of options.routes) {
      let files = 0;
      let duplicates = 0;
      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const job of jobs.filter(job => job.alias === alias && !blocked.has(alias) && stateAvailable)) {
        try {
          if (!await unchanged(job)) throw new Error('Claimed file changed.');
          const previous = accounts.get(alias);
          const duplicate = previous?.importedHashes.includes(job.hash) ?? false;
          const year = (job.latest ?? now.toISOString()).slice(0, 4);
          const accountArchive = await privateDirectory(join(archive, alias));
          const annualArchive = await privateDirectory(join(accountArchive, year));
          if ((await stat(annualArchive)).dev !== intakeDevice) throw new Error('Archive crosses filesystems.');
          if (duplicate) {
            duplicates++;
            skipped += job.rows.length;
          } else {
            const result = await options.importRows(route.actualAccount, job.rows);
            added += result.added;
            updated += result.updated;
            skipped += Math.max(0, job.rows.length - result.added - result.updated);
            const latestPostedDate = [previous?.latestPostedDate, job.latest].sort().filter(Boolean).at(-1);
            const next = new Map(accounts);
            next.set(alias, {
              identity: identities.get(alias)!, latestPostedDate, lastRun: now.toISOString(), importedHashes: [...previous?.importedHashes ?? [], job.hash],
            });
            try {
              await saveAccounts(state, next);
              accounts.set(alias, next.get(alias)!);
            } catch (error) {
              // A directory fsync can fail after rename. Re-read the installed
              // state before another account writes a replacement.
              stateAvailable = false;
              accounts = await loadAccounts(state, options.warn);
              stateAvailable = true;
              throw error;
            }
          }
          await move(job, await destination(annualArchive, job, duplicate ? '-duplicate' : ''));
          files++;
        } catch {
          options.warn(`${alias}: intake failed. Check the budget connection and data directories before retrying.`);
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
