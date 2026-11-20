import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
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
  minimumAgeSeconds: number;
  staleDays: number;
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

async function* scan(inbox: string, cutoff: number, warn: () => void, alias?: string): AsyncGenerator<Candidate> {
  for (const name of (await readdir(inbox)).sort()) {
    if (/\.(crdownload|part|download|tmp)$/i.test(name)) continue;
    const path = join(inbox, name);
    const info = await lstat(path).catch(error => {
      if (!isMissing(error)) throw error;
    });
    if (!info) continue;
    if (info.isDirectory()) {
      if (alias === undefined && safeAlias.test(name)) {
        try {
          await privateDirectory(path);
          yield* scan(path, cutoff, warn, name);
        } catch {
          warn();
        }
      }
    } else if (info.mtimeMs <= cutoff) {
      yield { path, info, alias };
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

async function move(candidate: Candidate, target: string): Promise<void> {
  if (!await unchanged(candidate)) throw new Error('Statement changed during intake.');
  await rename(candidate.path, target);
  await syncDirectory(dirname(target));
  await syncDirectory(dirname(candidate.path));
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
  await syncDirectory(directory);
  await syncDirectory(dirname(candidate.path));
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

async function prepare(candidate: Candidate, options: Options): Promise<Job | string | undefined> {
  if (candidate.info.isSymbolicLink()) return 'Symbolic links are not accepted.';
  if (!candidate.info.isFile() || candidate.info.nlink !== 1) return 'Expected a standalone regular file.';
  const extension = extname(candidate.path).toLowerCase();
  if (!['.qfx', '.ofx', '.csv'].includes(extension)) return 'Unsupported file extension.';
  const contents = await snapshot(candidate);
  if (!contents) return undefined;
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
    const archive = await privateDirectory(join(root, 'archive'));
    const rejected = await privateDirectory(join(root, 'quarantine'));
    const accounts = await loadAccounts(state, options.warn);
    const jobs: Job[] = [];
    let success = true;
    function scanFailed() {
      options.warn('Inbox directory could not be scanned. Check its ownership and permissions.');
      success = false;
    }
    for await (const candidate of scan(inbox, now.getTime() - options.minimumAgeSeconds * 1000, scanFailed)) {
      try {
        const job = await prepare(candidate, options);
        if (typeof job === 'string') await quarantine(rejected, candidate, job);
        else if (job) jobs.push(job);
      } catch {
        options.warn('Inbox file could not be processed. Check the data directories.');
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
      for (const job of jobs.filter(job => job.alias === alias)) {
        try {
          if (!await unchanged(job)) continue;
          const previous = accounts.get(alias);
          const duplicate = previous?.importedHashes.includes(job.hash) ?? false;
          const year = (job.latest ?? now.toISOString()).slice(0, 4);
          const accountArchive = await privateDirectory(join(archive, alias));
          const annualArchive = await privateDirectory(join(accountArchive, year));
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
              latestPostedDate, lastRun: now.toISOString(), importedHashes: [...previous?.importedHashes ?? [], job.hash],
            });
            await saveAccounts(state, next);
            accounts.set(alias, next.get(alias)!);
          }
          await move(job, await destination(annualArchive, job, duplicate ? '-duplicate' : ''));
          files++;
        } catch {
          options.warn(`${alias}: intake failed. Check the budget connection and data directories before retrying.`);
          success = false;
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
