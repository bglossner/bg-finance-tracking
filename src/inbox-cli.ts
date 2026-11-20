import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importIntoActual, readStatementImportConfig } from './actual.js';
import { runInbox } from './inbox.js';
import { parseAccounts } from './importers/chase.js';
import { privateDirectory, validDate } from './state/intake-state.js';

function integerSetting(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Set ${key} to a nonnegative integer.`);
  return Number(value);
}

async function main() {
  const dataRoot = process.env.BGFIN_DATA_DIR;
  const cutoff = process.env.BGFIN_HISTORY_CUTOFF;
  if (!dataRoot) throw new Error('Set BGFIN_DATA_DIR to a private data root outside the repository.');
  if (!validDate(cutoff)) throw new Error('Set BGFIN_HISTORY_CUTOFF to a valid YYYY-MM-DD date.');
  const contents = await readFile(process.env.BGFIN_ACCOUNTS_FILE ?? 'config/accounts.json', 'utf8').catch(() => {
    throw new Error('Cannot read accounts configuration. Set BGFIN_ACCOUNTS_FILE or create config/accounts.json.');
  });
  const routes = parseAccounts(contents);
  const cache = join(dataRoot, 'state', 'actual-cache');
  const env: NodeJS.ProcessEnv = { ...process.env, ACTUAL_CACHE_DIR: cache };
  const configs = new Map([...routes.values()].map(route => [route.actualAccount,
    readStatementImportConfig(env, route.actualAccount)]));
  const [connection] = configs.values();
  if (!connection) throw new Error('Configure at least one account alias.');
  let server: URL;
  try {
    server = new URL(connection.serverURL);
  } catch {
    throw new Error('Set ACTUAL_SERVER_URL to a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(server.protocol)) throw new Error('Set ACTUAL_SERVER_URL to a valid HTTP or HTTPS URL.');
  const budgetIdentity = JSON.stringify([server.href.replace(/\/+$/, ''), connection.syncId]);
  const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const report = console.log.bind(console);
  const warn = console.error.bind(console);
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const quiet = () => {};
  // Actual may log raw statement or budget data via console at any stage.
  Object.assign(console, { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet });
  try {
    const complete = await runInbox({
      dataRoot, repository, cutoff, routes, report, warn, budgetIdentity,
      minimumAgeSeconds: integerSetting('BGFIN_MIN_FILE_AGE_SECONDS', 10),
      staleDays: integerSetting('BGFIN_STALE_DAYS', 10),
      async importRows(account, rows) {
        await privateDirectory(cache);
        return importIntoActual(await import('@actual-app/api'), configs.get(account)!, rows);
      },
    });
    if (!complete) process.exitCode = 1;
  } finally {
    Object.assign(console, original);
  }
}

process.umask(0o077);
try {
  await main();
} catch (error) {
  console.error(error instanceof Error && !('code' in error) ? error.message : 'Inbox intake could not start. Check configuration and permissions.');
  process.exitCode = 1;
}
