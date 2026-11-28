import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { nextExportWindow } from './export-window.js';

export interface AccountState {
  identity: string;
  latestPostedDate?: string;
  lastRun: string;
  importedHashes: string[];
  lastBalanceCheck?: { status: 'ok' | 'mismatch'; date: string };
}

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    nextExportWindow(value);
    return true;
  } catch {
    return false;
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) || await realpath(path) !== path) {
    throw new Error('Expected a private directory owned by the importer.');
  }
  return path;
}

export async function createDataRoot(path: string, repository: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(dirname(path)) !== dirname(path)) {
    throw new Error('BGFIN_DATA_DIR must use an absolute path with an existing, canonical parent.');
  }
  const offset = relative(repository, path);
  if (!offset || (!offset.startsWith('../') && offset !== '..' && !isAbsolute(offset))) {
    throw new Error('BGFIN_DATA_DIR must be outside the repository.');
  }
  return privateDirectory(path);
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
  }
}

export async function withIntakeLock<T>(state: string, run: () => Promise<T>): Promise<T> {
  // flock locks the inherited open file description. The parent keeps it open
  // for the entire run, even if PID files survive a crash or Docker reuses a PID.
  const guard = await open(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const pidFile = join(state, 'import.lock');
  try {
    const lock = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', guard.fd],
    });
    if (lock.status === 75) throw new Error('Inbox import lock is held.');
    if (lock.status !== 0) throw new Error('Cannot acquire inbox import lock. Check that flock is installed.');
    // Once the kernel lock is held, any old PID record is stale. This check
    // works across PID namespaces and does not signal or probe another process.
    const previous = await lstat(pidFile).catch(error => {
      if (!isMissing(error)) throw error;
    });
    if (previous && !previous.isFile()) throw new Error('Invalid inbox lock record.');
    await atomicWrite(pidFile, `${process.pid}\n`);
    try {
      return await run();
    } finally {
      await unlink(pidFile);
    }
  } finally {
    await guard.close();
  }
}

function accountState(value: unknown): value is AccountState {
  if (!value || typeof value !== 'object') return false;
  const { identity, latestPostedDate, lastRun, importedHashes, lastBalanceCheck } = value as Partial<AccountState>;
  return typeof identity === 'string' && /^[a-f0-9]{64}$/.test(identity) && (latestPostedDate === undefined || validDate(latestPostedDate)) &&
    typeof lastRun === 'string' && Number.isFinite(Date.parse(lastRun)) &&
    Array.isArray(importedHashes) && importedHashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) &&
    (lastBalanceCheck === undefined || (lastBalanceCheck !== null && typeof lastBalanceCheck === 'object' &&
      Object.keys(lastBalanceCheck).length === 2 && validDate(lastBalanceCheck.date) &&
      (lastBalanceCheck.status === 'ok' || lastBalanceCheck.status === 'mismatch')));
}

export async function loadAccounts(directory: string, warn: (message: string) => void): Promise<Map<string, AccountState>> {
  const path = join(directory, 'accounts.json');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (!isMissing(error)) throw error;
  });
  if (!file) return new Map();
  let contents: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
      throw new Error('Expected a private state file owned by the importer.');
    }
    contents = await file.readFile('utf8');
  } finally {
    await file.close();
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const entries = Object.entries(value);
    if (!entries.every((entry): entry is [string, AccountState] => accountState(entry[1]))) throw new Error();
    return new Map(entries);
  } catch {
    await rename(path, join(directory, `accounts.corrupt-${randomUUID()}.json`));
    await syncDirectory(directory);
    warn('Corrupt accounts state preserved. Export windows will use the history cutoff until imports succeed.');
    return new Map();
  }
}

export async function saveAccounts(directory: string, accounts: Map<string, AccountState>): Promise<void> {
  await atomicWrite(join(directory, 'accounts.json'), `${JSON.stringify(Object.fromEntries(accounts), null, 2)}\n`);
}
