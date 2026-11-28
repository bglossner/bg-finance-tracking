import { randomUUID } from 'node:crypto';
import type * as Actual from '@actual-app/api';
import type { NormalizedTransaction } from './importers/source-adapter.js';

type ActualApi = Pick<typeof Actual,
  'init' | 'downloadBudget' | 'getAccounts' | 'importTransactions' | 'sync' | 'shutdown'>;
type StatementApi = ActualApi & Pick<typeof Actual,
  'getTransactions' | 'getAccountBalance' | 'getPayees' | 'createPayee' | 'getCategories'>;
type ActualClient = Awaited<ReturnType<ActualApi['init']>>;

const startingBalanceId = 'bgfin:starting-balance';

export interface StatementBalance {
  date: string;
  amountMinor: number;
}

export interface StatementImport {
  balance?: StatementBalance;
  cutoff: string;
  setStartingBalance: boolean;
  skipTransactions: boolean;
}

export interface ImportResult {
  added: number;
  updated: number;
  balanceCheck?: { date: string; difference: bigint };
}

export class StartingBalanceError extends Error {}

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
        typeof imported_id !== 'string' || !imported_id.trim() || imported_id === startingBalanceId || ids.has(imported_id) ||
        (payee !== undefined && typeof payee !== 'string')) {
      throw new Error(`Transaction ${index + 1} has an invalid amount, date, source ID or payee.`);
    }
    ids.add(imported_id);
    return { amountMinor, postedDate, imported_id, payee };
  });
}

interface AccountTransaction {
  id: string;
  date: string;
  amount: number;
  imported_id?: string | null;
  starting_balance_flag?: boolean | null;
  is_parent?: boolean;
  is_child?: boolean;
  transfer_id?: string | null;
  subtransactions?: AccountTransaction[];
}

function startingTransaction(transactions: AccountTransaction[]): AccountTransaction | undefined {
  const candidates = transactions.flatMap(row => [row, ...row.subtransactions ?? []])
    .filter(row => row.starting_balance_flag || row.imported_id === startingBalanceId);
  if (candidates.length > 1 ||
      candidates.some(row => row.is_parent || row.is_child || row.subtransactions?.length || row.transfer_id)) {
    throw new StartingBalanceError('Starting balance is ambiguous. Keep one standalone opening transaction before retrying.');
  }
  return candidates[0];
}

async function accountTransactions(api: StatementApi, accountId: string): Promise<AccountTransaction[]> {
  // Actual treats empty bounds as unbounded and returns grouped splits.
  return api.getTransactions(accountId, '', '');
}

async function balanceThrough(api: StatementApi, accountId: string, date: string): Promise<bigint> {
  const [year, month, day] = date.split('-').map(Number);
  // Actual converts Date back to the local calendar day in its inclusive query.
  const balance = await api.getAccountBalance(accountId, new Date(year, month - 1, day, 12));
  if (!Number.isSafeInteger(balance)) throw new Error('Actual balance exceeds the supported range.');
  return BigInt(balance);
}

function openingDate(cutoff: string, asOf: string, transactionDates: string[]): string {
  // Include the statement date for statements with no activity through that day.
  const earliest = transactionDates.reduce((day, date) => date < day ? date : day, cutoff < asOf ? cutoff : asOf);
  const date = new Date(Date.parse(earliest) - 86_400_000).toISOString().slice(0, 10);
  if (date < '1995-01-01') {
    throw new StartingBalanceError('Actual supports opening dates from 1995-01-01 onward.');
  }
  return date;
}

async function setOpeningTransaction(
  api: StatementApi, client: ActualClient, accountId: string, offbudget: boolean | undefined, balance: StatementBalance, cutoff: string,
): Promise<void> {
  const transactions = await accountTransactions(api, accountId);
  const opening = startingTransaction(transactions);
  const through = await balanceThrough(api, accountId, balance.date);
  if (opening && !Number.isSafeInteger(opening.amount)) throw new Error('Actual opening amount exceeds the supported range.');
  const previous = opening && opening.date <= balance.date ? BigInt(opening.amount) : 0n;
  const amount = Number(BigInt(balance.amountMinor) - through + previous);
  if (!Number.isSafeInteger(amount)) throw new Error('Starting balance exceeds the supported range.');

  const date = openingDate(cutoff, balance.date, transactions.filter(row => row.id !== opening?.id).map(row => row.date));
  const fields = { amount, date, imported_id: startingBalanceId, starting_balance_flag: true };
  if (opening) {
    if (opening.amount !== amount || opening.date !== date || opening.imported_id !== startingBalanceId || !opening.starting_balance_flag) {
      await client.send('transactions-batch-update', { updated: [{ id: opening.id, ...fields }], runTransfers: false });
    }
  } else {
    const income = offbudget ? [] : (await api.getCategories()).filter(category => category.is_income);
    const category = income.find(category => category.name.toLowerCase() === 'starting balances') ?? income[0];
    const existingPayee = (await api.getPayees()).find(payee => !payee.transfer_acct && payee.name.toLowerCase() === 'starting balance');
    const payee = existingPayee?.id ?? await api.createPayee({ name: 'Starting Balance' });
    // The pinned Actual batch handler posts through the normal sync model.
    // Unlike addTransactions it skips budget rules, which can split or retag the opening.
    await client.send('transactions-batch-update', {
      added: [{ id: randomUUID(), ...fields, account: accountId, payee, category: category?.id ?? null, cleared: true }],
      runTransfers: false,
    });
  }
}

export function importIntoActual(api: ActualApi, config: ImportConfig, rows: ImportRow[]): Promise<ImportResult>;
export function importIntoActual(api: StatementApi, config: ImportConfig, rows: ImportRow[], statement: StatementImport): Promise<ImportResult>;
export async function importIntoActual(
  api: ActualApi | StatementApi, config: ImportConfig, rows: ImportRow[], statement?: StatementImport,
): Promise<ImportResult> {
  const { serverURL, password, dataDir, syncId, e2ePassword } = config;
  const client = await api.init({ serverURL, password, dataDir, verbose: false });
  try {
    await api.downloadBudget(syncId, { password: e2ePassword });
    const accounts = await api.getAccounts();
    const matches = accounts.filter(account => !account.closed && ('accountId' in config
      ? account.id === config.accountId
      : account.id === config.accountReference || account.name === config.accountReference));
    if (matches.length !== 1) throw new Error('The alias must resolve to exactly one open account in the selected budget.');
    const { id: accountId, offbudget } = matches[0];
    const statementApi = api as StatementApi;
    if (statement && (!statement.skipTransactions && rows.length || statement.setStartingBalance)) {
      // Actual's fuzzy matching can take a native opening transaction with
      // no imported ID for a posted row of the same amount and nearby date.
      const transactions = await accountTransactions(statementApi, accountId);
      const opening = startingTransaction(transactions);
      if (statement.setStartingBalance && statement.balance) {
        const dates = transactions.filter(row => row.id !== opening?.id).map(row => row.date);
        if (!statement.skipTransactions) for (const row of rows) dates.push(row.postedDate);
        openingDate(statement.cutoff, statement.balance.date, dates);
      }
      if (opening && !opening.imported_id) {
        await client.send('transactions-batch-update', {
          updated: [{ id: opening.id, imported_id: startingBalanceId }], runTransfers: false,
        });
      }
    }
    const result = statement?.skipTransactions ? { added: [], updated: [], errors: [] } :
      await api.importTransactions(accountId, rows.map(row => ({
        account: accountId,
        amount: row.amountMinor,
        date: row.postedDate,
        imported_id: row.imported_id,
        payee_name: row.payee,
      })));
    if (result.errors.length) throw new Error('Actual rejected the import.');
    if (statement?.balance && statement.setStartingBalance) {
      await setOpeningTransaction(statementApi, client, accountId, offbudget, statement.balance, statement.cutoff);
    }
    await api.sync();
    if (statement?.balance) {
      const { date, amountMinor } = statement.balance;
      const difference = await balanceThrough(statementApi, accountId, date) - BigInt(amountMinor);
      return { added: result.added.length, updated: result.updated.length, balanceCheck: { date, difference } };
    }
    return { added: result.added.length, updated: result.updated.length };
  } finally {
    await api.shutdown();
  }
}
