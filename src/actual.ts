import type * as Actual from '@actual-app/api';
import type { NormalizedTransaction } from './importers/source-adapter.js';

type ActualApi = Pick<typeof Actual,
  'init' | 'downloadBudget' | 'getAccounts' | 'importTransactions' | 'sync' | 'shutdown'>;

interface ImportConnection {
  serverURL: string;
  password: string;
  dataDir: string;
  syncId: string;
  e2ePassword?: string;
}

type ImportConfig = ImportConnection & ({ accountId: string } | { accountReference: string });

export function readImportConfig(env: NodeJS.ProcessEnv, alias: string): ImportConnection & { accountId: string } {
  let accounts: unknown;
  try {
    accounts = JSON.parse(env.ACTUAL_ACCOUNTS ?? '');
  } catch {
    throw new Error('Set ACTUAL_ACCOUNTS to a JSON object mapping aliases to account IDs.');
  }
  const accountId = accounts && typeof accounts === 'object' && !Array.isArray(accounts) &&
    Object.hasOwn(accounts, alias) ? (accounts as Record<string, unknown>)[alias] : undefined;
  if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('Unknown account alias.');

  return { ...readConnection(env), accountId };
}

export function readStatementImportConfig(env: NodeJS.ProcessEnv, accountReference: string): ImportConfig {
  return { ...readConnection(env), accountReference };
}

function readConnection(env: NodeJS.ProcessEnv): ImportConnection {
  function required(key: string): string {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Set ${key}.`);
    return value;
  }

  return {
    serverURL: required('ACTUAL_SERVER_URL'),
    password: required('ACTUAL_SERVER_PASSWORD'),
    dataDir: required('ACTUAL_CACHE_DIR'),
    syncId: required('ACTUAL_BUDGET_SYNC_ID'),
    e2ePassword: env.ACTUAL_E2E_PASSWORD || undefined,
  };
}

export type ImportRow = NormalizedTransaction & { readonly payee?: string };

export function parseImportRows(contents: string): ImportRow[] {
  let rows: unknown;
  try {
    rows = JSON.parse(contents);
  } catch {
    throw new Error('Input must be valid JSON.');
  }
  if (!Array.isArray(rows)) throw new Error('Input must be an array of transactions.');

  const ids = new Set<string>();
  return rows.map((row: unknown, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Transaction ${index + 1} must be an object.`);
    }
    const { amountMinor, postedDate, imported_id, payee } = row as Record<string, unknown>;
    if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) ||
        typeof postedDate !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(postedDate) ||
        !Number.isFinite(Date.parse(postedDate)) ||
        new Date(postedDate).toISOString().slice(0, 10) !== postedDate ||
        typeof imported_id !== 'string' || !imported_id.trim() || ids.has(imported_id) ||
        (payee !== undefined && typeof payee !== 'string')) {
      throw new Error(`Transaction ${index + 1} has an invalid amount, date, source ID or payee.`);
    }
    ids.add(imported_id);
    return { amountMinor, postedDate, imported_id, payee };
  });
}

export async function importIntoActual(api: ActualApi, config: ImportConfig, rows: ImportRow[]) {
  const { serverURL, password, dataDir, syncId, e2ePassword } = config;
  await api.init({ serverURL, password, dataDir, verbose: false });
  try {
    await api.downloadBudget(syncId, { password: e2ePassword });
    const accounts = await api.getAccounts();
    const matches = accounts.filter(account => !account.closed && ('accountId' in config
      ? account.id === config.accountId
      : account.id === config.accountReference || account.name === config.accountReference));
    if (matches.length !== 1) throw new Error('The alias must resolve to exactly one open account in the selected budget.');
    const { id: accountId } = matches[0];
    const result = await api.importTransactions(accountId, rows.map(row => ({
      account: accountId,
      amount: row.amountMinor,
      date: row.postedDate,
      imported_id: row.imported_id,
      payee_name: row.payee,
    })));
    if (result.errors.length) throw new Error('Actual rejected the import.');
    await api.sync();
    return { added: result.added.length, updated: result.updated.length };
  } finally {
    await api.shutdown();
  }
}
