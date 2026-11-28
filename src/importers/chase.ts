import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, matchesGlob } from 'node:path';
import { parseImportRows, type ImportRow, type StatementBalance } from '../actual.js';
import type { SourceAdapter } from './source-adapter.js';
import { InvalidStatement, parseActualFile } from './actual-file-parser.js';

interface AccountRoute {
  actualAccount: string;
  last4: string;
  filename: string;
}

type Routes = ReadonlyMap<string, AccountRoute>;

export function parseAccounts(contents: string): Routes {
  try {
    const config: unknown = JSON.parse(contents);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    const routes = new Map<string, AccountRoute>();
    for (const [alias, value] of Object.entries(config)) {
      if (!alias.trim() || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const { actualAccount, last4, filename } = value;
      if (typeof actualAccount !== 'string' || !actualAccount.trim() ||
          typeof last4 !== 'string' || !/^\d{4}$/.test(last4) ||
          typeof filename !== 'string' || !filename.trim() || /[/\\]/.test(filename)) throw new Error();
      routes.set(alias, { actualAccount, last4, filename });
    }
    return routes;
  } catch {
    throw new Error('Invalid accounts configuration. Expected aliases with actualAccount, last4 and filename.');
  }
}

export function matchAccount(routes: Routes, path: string, last4?: string, alias?: string): string {
  const filename = basename(path);
  const matches = [...routes].filter(([, route]) =>
    matchesGlob(filename, route.filename) || (last4 !== undefined && route.last4 === last4));
  if (alias !== undefined) {
    const route = routes.get(alias);
    if (!route) throw new Error('Unknown account alias.');
    if (last4 !== undefined && route.last4 !== last4) throw new Error('Statement account conflicts with the selected alias.');
    return alias;
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous statement account.' : 'Unmatched statement account.');
  const [matchedAlias, route] = matches[0];
  if (last4 !== undefined && route.last4 !== last4) throw new Error('Statement account conflicts with the filename match.');
  return matchedAlias;
}

export function routeAccount(routes: Routes, path: string, last4?: string, alias?: string): string {
  return routes.get(matchAccount(routes, path, last4, alias))!.actualAccount;
}

// Actual's parser returns transactions only. Validate the statement envelope
// before reading routing or ledger metadata from its response.
function ofxStatement(contents: Buffer) {
  const text = contents.toString('latin1');
  const identifiers = [...text.matchAll(/<ACCTID\s*>([^<]*)/gi)];
  const responses = [...text.matchAll(/<(?:STMTRS|CCSTMTRS)\s*>/g)];
  const bank = text.match(/<BANKMSGSRSV1\s*>\s*<STMTTRNRS\s*>(?:(?!<\/?STMTTRNRS)[^])*?<STMTRS\s*>([^]*?)<\/STMTRS\s*>/d);
  const card = text.match(/<CREDITCARDMSGSRSV1\s*>\s*<CCSTMTTRNRS\s*>(?:(?!<\/?CCSTMTTRNRS)[^])*?<CCSTMTRS\s*>([^]*?)<\/CCSTMTRS\s*>/d);
  const account = bank?.[1].match(/^\s*<CURDEF\s*>USD\s*(?:<\/CURDEF\s*>)?\s*<BANKACCTFROM\s*>([^]*?)<\/BANKACCTFROM\s*>/) ??
    card?.[1].match(/^\s*<CURDEF\s*>USD\s*(?:<\/CURDEF\s*>)?\s*<CCACCTFROM\s*>([^]*?)<\/CCACCTFROM\s*>/);
  const identifier = identifiers[0]?.[1]?.trim();
  if (!account || identifiers.length > 1 || responses.length !== 1 ||
      [...text.matchAll(/<CURDEF\s*>/gi)].length !== 1 || /<CURRENCY\s*>/i.test(text) ||
      [...text.matchAll(/<(?:BANKACCTFROM|CCACCTFROM)\s*>/gi)].length !== 1 ||
      [...text.matchAll(/<(?:BANKMSGSRSV1|CREDITCARDMSGSRSV1)\s*>/gi)].length !== 1 ||
      (identifiers.length === 1 && !/<ACCTID\s*>/.test(account[1])) ||
      /<(?!\/?(?:BANKID|BRANCHID|ACCTID|ACCTTYPE|ACCTKEY)\s*>)/.test(account[1]) ||
      /<!--|<!\[CDATA\[|<INVSTMTMSGSRSV1/i.test(text)) {
    throw new Error('Expected a single checking or card account in the statement.');
  }
  const last4 = identifier && /^(?:[0-9Xx*]+-|[0-9Xx*]*)(\d{4})$/.exec(identifier)?.[1];
  if (identifier && !last4) throw new Error('Invalid statement account identifier.');
  const response = (bank ?? card)!;
  const afterAccount = response.indices![1]![0] + account[0].length;
  return { last4: last4 || undefined, card: Boolean(card), response: response[1], text, afterAccount, end: response.indices![1]![1] };
}

export function ofxAccountSuffix(contents: Buffer): string | undefined {
  return ofxStatement(contents).last4;
}

function balanceDate(raw: string): string | undefined {
  const match = /^([1-9]\d{3})(\d{2})(\d{2})(?:([01]\d|2[0-3])([0-5]\d)([0-5]\d|60)(?:\.\d{1,3})?(?:\s*\[([+-]?\d{1,2}(?:\.\d{1,2})?)(?::[A-Za-z]{1,5})?\])?)?$/.exec(raw.trim());
  if (!match || (match[7] && Math.abs(Number(match[7])) > 12)) return undefined;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date) return date;
}

function ledgerOffset(statement: ReturnType<typeof ofxStatement>): number {
  // In both response types LEDGERBAL follows the account and optional posted
  // and pending transaction lists.
  const prefix = /^\s*(?:<BANKTRANLIST\s*>[^]*?<\/BANKTRANLIST\s*>\s*)?(?:<BANKTRANLISTP\s*>[^]*?<\/BANKTRANLISTP\s*>\s*)?/
    .exec(statement.text.slice(statement.afterAccount))![0];
  return statement.afterAccount + prefix.length;
}

export function readStatementBalance(contents: Buffer, extension: string): StatementBalance | undefined {
  if (extension === '.csv') return undefined;
  const statement = ofxStatement(contents);
  if ([...statement.response.matchAll(/<LEDGERBAL\s*>/g)].length !== 1) return undefined;
  const fields = /^<LEDGERBAL\s*>\s*<BALAMT\s*>([^<]*)(?:<\/BALAMT\s*>)?\s*<DTASOF\s*>([^<]*)(?:<\/DTASOF\s*>)?\s*<\/LEDGERBAL\s*>/
    .exec(statement.text.slice(ledgerOffset(statement)));
  if (!fields) return undefined;
  const date = balanceDate(fields[2]);
  if (!date) return undefined;
  try {
    // Keep OFX decimal commas and extra precision consisting of zeros exact.
    const raw = fields[1].trim();
    const parts = /^([+-]?)(\d*)(?:[.,](\d*))?$/.exec(raw);
    if (raw.length > 32 || !parts || !(parts[2] || parts[3]) || /[1-9]/.test(parts[3]?.slice(2) ?? '')) return undefined;
    const cents = toCents(`${parts[1]}${parts[2] || '0'}.${(parts[3] ?? '').padEnd(2, '0').slice(0, 2)}`);
    // Chase card exports can express debt as a positive balance owed.
    return { date, amountMinor: statement.card && cents > 0 ? -cents : cents };
  } catch {
    return undefined;
  }
}

function transactionParserInput(contents: Buffer): Buffer {
  const statement = ofxStatement(contents);
  const offset = ledgerOffset(statement);
  // Empty SGML balance leaves and missing aggregate closures can make
  // Actual's transaction-only parser reject otherwise readable posted rows.
  const tail = statement.text.slice(offset, statement.end).replace(
    /<LEDGERBAL\s*>(?:(?!<\/?LEDGERBAL|<AVAILBAL)[^])*?(?:<\/LEDGERBAL\s*>|(?=<LEDGERBAL\s*>|<AVAILBAL\s*>|$))/g, '',
  );
  const text = statement.text.slice(0, offset) + tail + statement.text.slice(statement.end);
  return Buffer.from(statement.last4 === undefined
    ? text.replace(/<ACCTID\s*>\s*(?:<\/ACCTID\s*>)?(?=\s*<)/g, '')
    : text, 'latin1');
}

export function toCents(value: string): number {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error('Statement has an invalid amount.');
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Statement amount exceeds the supported range.');
  return Number(match[1] === '-' ? -cents : cents);
}

const checkingHeader = ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'];
const cardHeader = ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo'];

export function normalizeCsv([header, ...data]: string[][]): ImportRow[] {
  const matches = (expected: string[]) => header?.length === expected.length && expected.every((field, i) => header[i] === field);
  const checking = matches(checkingHeader);
  if (!checking && !matches(cardHeader)) throw new Error('Unrecognized Chase CSV headers.');
  const occurrences = new Map<string, number>();
  return data.map(row => {
    // Chase checking exports may include an extra trailing delimiter on data rows.
    if (checking && row.length === header.length + 1 && row.at(-1) === '') row = row.slice(0, -1);
    if (row.length !== header.length) throw new Error('A Chase CSV row has the wrong number of columns.');
    const [,, payee] = row;
    const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row[1]);
    if (!date) throw new Error('Statement has an invalid posting date.');
    const postedDate = `${date[3]}-${date[1]}-${date[2]}`;
    const amountMinor = toCents(row[checking ? 3 : 5]);
    const key = createHash('sha256').update(JSON.stringify([
      checking ? 'checking' : 'card', postedDate, amountMinor, payee, row[4],
      ...(checking ? [row[0], row[6]] : [row[0]]),
    ])).digest('hex');
    const index = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, index);
    return { payee, postedDate, amountMinor, imported_id: `chase-csv:${key}:${index}` };
  });
}

// Actual normalizes dates and amounts before returning rows. Check the original
// tokens so a rollover, rounding or permissive number parse cannot go unnoticed.
function verifyOfxValues(contents: Buffer, rows: ImportRow[]): void {
  const text = contents.toString('latin1');
  const blocks = [...text.matchAll(/<STMTTRN\s*>([^]*?)<\/STMTTRN\s*>/g)];
  if (blocks.length !== rows.length || [...text.matchAll(/<STMTTRN\s*>/g)].length !== rows.length) {
    throw new Error('Statement transaction count disagrees with the Actual parser.');
  }
  for (const [index, [, block]] of blocks.entries()) {
    const amounts = [...block.matchAll(/<TRNAMT\s*>([^<\r\n]*)/g)];
    const dates = [...block.matchAll(/<DTPOSTED\s*>([^<\r\n]*)/g)];
    const date = /^(\d{4})(\d{2})(\d{2})(?:\d{6}(?:\.\d+)?(?:\[[^\]]+\])?)?$/.exec(dates[0]?.[1].trim() ?? '');
    if (dates.length !== 1 || !date || `${date[1]}-${date[2]}-${date[3]}` !== rows[index].postedDate ||
        amounts.length !== 1 || toCents(amounts[0][1]) !== rows[index].amountMinor) {
      throw new Error('Statement amount or posting date disagrees with the Actual parser.');
    }
  }
}

export function normalizeOfx(rows: readonly {
  amount: number;
  postedDate: string;
  fitid?: string;
  payee?: string;
}[]): ImportRow[] {
  const fitids = new Set<string>();
  return rows.map(({ amount, postedDate, fitid, payee }) => {
    if (!fitid?.trim() || /^0+$/.test(fitid.trim()) || fitids.has(fitid)) {
      throw new Error('Statement has a missing, all-zero or duplicate FITID.');
    }
    fitids.add(fitid);
    // Stay below the point where a JS number's spacing could hide a cent.
    if (Math.abs(amount) >= 2 ** 46) throw new Error('OFX amount exceeds the supported range.');
    return { amountMinor: toCents(String(amount)), postedDate, imported_id: fitid, payee };
  });
}

export function matchStatement(routes: Routes, path: string, contents: Buffer, alias?: string): string {
  const isOfx = extname(path).toLowerCase() !== '.csv';
  const last4 = isOfx ? ofxAccountSuffix(contents) : undefined;
  if (isOfx && last4 === undefined && alias === undefined) {
    throw new Error('Statement has no account identifier. Supply --account explicitly.');
  }
  return matchAccount(routes, path, last4, alias);
}

export async function parseStatement(contents: Buffer, extension: string): Promise<ImportRow[]> {
  const format = extension === '.csv' ? 'csv' : 'ofx';
  const directory = await mkdtemp(join(tmpdir(), 'bgfin-statement-'));
  try {
    const snapshot = join(directory, `statement${extension}`);
    const input = format === 'ofx' ? transactionParserInput(contents) : contents;
    await writeFile(snapshot, input, { mode: 0o600 });
    const parsed = await parseActualFile(snapshot, format);
    try {
      const rows = parsed.format === 'csv' ? normalizeCsv(parsed.rows) : normalizeOfx(parsed.rows);
      if (parsed.format === 'ofx') verifyOfxValues(contents, rows);
      return parseImportRows(JSON.stringify(rows));
    } catch (error) {
      throw new InvalidStatement(error instanceof Error ? error.message : 'Invalid Chase statement.');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const chase = {
  async parse(path, { routes, alias }) {
    const extension = extname(path).toLowerCase();
    if (!['.csv', '.qfx', '.ofx'].includes(extension)) throw new Error('Expected a Chase CSV, QFX or OFX file.');
    const contents = await readFile(path).catch(() => { throw new Error('Cannot read statement file.'); });
    const matched = matchStatement(routes, path, contents, alias);
    return {
      account: routes.get(matched)!.actualAccount, alias: matched, extension,
      rows: await parseStatement(contents, extension), balance: readStatementBalance(contents, extension),
      hash: createHash('sha256').update(contents).digest('hex'),
    };
  },
} satisfies SourceAdapter<{ routes: Routes; alias?: string }, ImportRow>;
