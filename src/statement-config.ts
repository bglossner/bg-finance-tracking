import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importIntoActual, readStatementImportConfig } from './actual.js';
import type { runSingleStatement } from './inbox.js';
import { privateDirectory, validDate } from './state/intake-state.js';

type Options = Parameters<typeof runSingleStatement>[0];

export async function statementSettings(env: NodeJS.ProcessEnv, routes: Options['routes']) {
  const dataRoot = env.BGFIN_DATA_DIR;
  const cutoff = env.BGFIN_HISTORY_CUTOFF;
  if (!dataRoot) throw new Error('Set BGFIN_DATA_DIR to a private data root outside the repository.');
  if (!validDate(cutoff) || !/^[1-9]/.test(cutoff)) throw new Error('Set BGFIN_HISTORY_CUTOFF to a valid YYYY-MM-DD date (years 1000–9999).');
  if (!routes.size) throw new Error('Configure at least one account alias.');
  const cache = join(dataRoot, 'state', 'actual-cache');
  const config = readStatementImportConfig({ ...env, ACTUAL_CACHE_DIR: cache }, '');
  let server: URL;
  try {
    server = new URL(config.serverURL);
  } catch {
    throw new Error('Set ACTUAL_SERVER_URL to a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(server.protocol)) throw new Error('Set ACTUAL_SERVER_URL to a valid HTTP or HTTPS URL.');
  const budgetIdentity = JSON.stringify([server.href.replace(/\/+$/, ''), config.syncId]);
  const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const importRows: Options['importRows'] = async (accountReference, rows, statement) => {
    await privateDirectory(cache);
    return importIntoActual(await import('@actual-app/api'), { ...config, accountReference }, rows, statement);
  };
  return { dataRoot, cutoff, repository, routes, budgetIdentity, importRows };
}

export async function quietActual<T>(run: () => Promise<T>): Promise<T> {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const quiet = () => {};
  // Actual may log transaction fields from statement parsing or budget rules.
  Object.assign(console, { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet });
  try {
    return await run();
  } finally {
    Object.assign(console, original);
  }
}
