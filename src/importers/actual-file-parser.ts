import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const apiPackage = '@actual-app/api';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve(apiPackage)), 'utf8')) as { version: string };

interface HandlerOfxRow {
  amount: number;
  date: string;
  imported_id: string | undefined;
  payee_name: string | null;
}

type Result = { format: 'csv'; rows: string[][] } | { format: 'ofx'; rows: { amount: number; postedDate: string; fitid?: string; payee?: string }[] };

function mismatch(): Error {
  return new Error(`Unsupported statement parser response from ${apiPackage} ${version}. Check parser compatibility.`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateParserResult(format: Result['format'], value: unknown): Result {
  if (!record(value) || !Array.isArray(value.errors) ||
      !value.errors.every(error => record(error) && typeof error.message === 'string') ||
      (!Array.isArray(value.transactions) && !(format === 'ofx' && value.errors.length && value.transactions === undefined))) {
    throw mismatch();
  }
  if (value.errors.length) throw new Error(`${apiPackage} ${version} could not parse the statement.`);
  const rows = value.transactions as unknown[];
  if (format === 'csv') {
    if (!rows.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'))) throw mismatch();
    return { format, rows: rows as string[][] };
  }
  if (!rows.every(row => record(row) && typeof row.amount === 'number' && Number.isFinite(row.amount) &&
    typeof row.date === 'string' && (row.imported_id === undefined || typeof row.imported_id === 'string') &&
    (row.payee_name === null || typeof row.payee_name === 'string'))) throw mismatch();
  return { format, rows: (rows as HandlerOfxRow[]).map(row => ({
    amount: row.amount, postedDate: row.date, fitid: row.imported_id, payee: row.payee_name ?? undefined,
  })) };
}

export async function parseActualFile(filepath: string, format: Result['format']): Promise<Result> {
  const dataDir = await mkdtemp(join(tmpdir(), 'bgfin-parser-'));
  try {
    const api = await import('@actual-app/api');
    const client: unknown = await api.init({ dataDir, verbose: false });
    try {
      if (!record(client) || typeof client.send !== 'function') throw mismatch();
      let response: unknown;
      try {
        response = await client.send('transactions-parse-file', { filepath, options: { hasHeaderRow: false } });
      } catch {
        throw new Error(`${apiPackage} ${version} statement parser failed. Check the file and parser compatibility.`);
      }
      return validateParserResult(format, response);
    } finally {
      await api.shutdown();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
