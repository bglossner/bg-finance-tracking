import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateParserResult } from '../src/importers/actual-file-parser.js';
import { chase, matchStatement, normalizeCsv, normalizeOfx, ofxAccountSuffix, parseAccounts, readStatementBalance, routeAccount, toCents } from '../src/importers/chase.js';

const routes = parseAccounts(JSON.stringify({
  checking: { actualAccount: 'Synthetic Checking', last4: '1234', filename: 'checking-*.csv' },
  card: { actualAccount: 'Synthetic Card', last4: '5678', filename: 'card-*.csv' },
}));
const fixture = (name: string) => join('test/fixtures', name);
const native = { skip: process.env.BGFIN_CONTAINER_TESTS !== '1' && 'Requires the Docker job image (npm run test:container)' };

test('converts decimal strings into exact cents', () => {
  assert.equal(toCents('0.10') + toCents('0.20'), 30);
  assert.equal(toCents('-0.10'), -10);
  assert.throws(() => toCents('0.001'), /invalid amount/);
  assert.throws(() => toCents('90071992547409.92'), /supported range/);
});

test('reads only the ledger balance and applies Chase card debt signs', async () => {
  const checking = await readFile(fixture('checking-synthetic.qfx'), 'utf8');
  const card = await readFile(fixture('card-synthetic.qfx'), 'utf8');
  assert.deepEqual(readStatementBalance(Buffer.from(checking), '.qfx'), { date: '2026-01-02', amountMinor: 5000 });
  assert.deepEqual(readStatementBalance(Buffer.from(card), '.qfx'), { date: '2026-01-02', amountMinor: -2005 });
  assert.deepEqual(readStatementBalance(Buffer.from(card.replace('>20.05<', '>-20.05<')), '.ofx'),
    { date: '2026-01-02', amountMinor: -2005 });
  assert.deepEqual(readStatementBalance(Buffer.from(checking.replace('50.00<DTASOF>20260102',
    '-0,0100</BALAMT><DTASOF>20260102</DTASOF>')), '.ofx'), { date: '2026-01-02', amountMinor: -1 });
  assert.equal(readStatementBalance(Buffer.from(checking), '.csv'), undefined);
});

test('treats absent, nested, duplicate, malformed and inexact ledger balances as absent', async () => {
  const text = await readFile(fixture('checking-synthetic.qfx'), 'utf8');
  const ledger = text.match(/<LEDGERBAL>[^]*?<\/LEDGERBAL>/)![0];
  for (const input of [
    text.replace(ledger, ''),
    text.replace(ledger, '').replace('</STMTTRN>', `${ledger}</STMTTRN>`),
    text.replace(ledger, ledger + ledger),
    text.replace('<DTASOF>20260102</LEDGERBAL>', '</LEDGERBAL>'),
    text.replace('DTASOF>20260102</LEDGERBAL>', 'DTASOF>20260230</LEDGERBAL>'),
    text.replace('DTASOF>20260102</LEDGERBAL>', 'DTASOF>20260102246000[99]</LEDGERBAL>'),
    text.replace('BALAMT>50.00', 'BALAMT>50.001'),
    text.replace('BALAMT>50.00', 'BALAMT>90071992547409.92'),
    text.replace('BALAMT>50.00', 'BALAMT>literal'),
    text.replace('</LEDGERBAL>', ''),
  ]) {
    assert.equal(readStatementBalance(Buffer.from(input), '.qfx'), undefined);
  }
});

test('matches basenames, account suffixes and explicit aliases; fails closed on conflicts', () => {
  assert.equal(routeAccount(routes, '/private/card-fake.csv'), 'Synthetic Card');
  assert.equal(routeAccount(routes, 'fake.qfx', '1234'), 'Synthetic Checking');
  assert.equal(routeAccount(routes, 'renamed.csv', undefined, 'checking'), 'Synthetic Checking');
  assert.throws(() => routeAccount(routes, 'unknown.csv'), /Unmatched/);
  assert.throws(() => routeAccount(routes, 'card-fake.csv', '1234'), /Ambiguous/);
  assert.throws(() => routeAccount(routes, 'card-fake.csv', '9999'), /conflicts/);
  assert.throws(() => routeAccount(routes, 'fake.qfx', '1234', 'card'), /conflicts/);
  assert.throws(() => routeAccount(routes, 'fake.qfx', undefined, 'constructor'), /Unknown/);
  assert.throws(() => parseAccounts('{"checking":{"actualAccount":"Fake","last4":"000001234","filename":"*.csv"}}'), /Invalid accounts/);
});

test('reads only the last four account digits and rejects multiple account aggregates', async () => {
  const contents = await readFile(fixture('checking-synthetic.qfx'), 'utf8');
  assert.equal(ofxAccountSuffix(Buffer.from(contents)), '1234');
  assert.equal(ofxAccountSuffix(Buffer.from(contents.replace('0000001234', '\n0000001234</ACCTID>'))), '1234');
  assert.equal(ofxAccountSuffix(Buffer.from(contents.replace('0000001234', 'XXXX1234'))), '1234');
  assert.equal(ofxAccountSuffix(Buffer.from(contents.replace('<ACCTID>0000001234', ''))), undefined);
  assert.throws(() => ofxAccountSuffix(Buffer.from(contents.replaceAll('BANKACCTFROM', 'CCACCTFROM'))), /single checking or card/);
  assert.throws(() => ofxAccountSuffix(Buffer.from(contents.replace('0000001234', '0000001234<ACCTID>0000005678'))), /single checking or card/);
});

test('routes a hyphenated ACCTID by its explicit suffix and rejects malformed suffixes', async () => {
  const contents = await readFile(fixture('checking-synthetic.qfx'), 'utf8');
  const withId = (id: string) => Buffer.from(contents.replace('0000001234', id));
  for (const id of ['0000005678-1234', 'Xx**-1234']) {
    assert.equal(matchStatement(routes, 'renamed.qfx', withId(id)), 'checking');
    assert.throws(() => matchStatement(routes, 'renamed.qfx', withId(id), 'card'), /conflicts/);
  }
  for (const id of ['0000005678-01234', '0000005678-234', '0000-5678-1234', '-1234']) {
    assert.throws(() => matchStatement(routes, 'renamed.qfx', withId(id), 'checking'), /Invalid statement account/);
  }
});

test('keeps duplicate CSV rows distinct and stable when other rows reorder', () => {
  const header = ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo'];
  const sale = ['11/14/2026', '11/16/2026', 'Imaginary Shop', 'Fake', 'Sale', '-0.10', ''];
  const payment = ['11/16/2026', '11/17/2026', 'Imaginary Payment', '', 'Payment', '0.20', ''];
  const first = normalizeCsv([header, sale, sale, payment]);
  const second = normalizeCsv([header, payment, sale, sale]);
  assert.deepEqual(first, [second[1], second[2], second[0]]);
  assert.equal(new Set(first.map(row => row.imported_id)).size, 3);
  assert.deepEqual(first.map(row => [row.amountMinor, row.postedDate]), [[-10, '2026-11-16'], [-10, '2026-11-16'], [20, '2026-11-17']]);
  assert.throws(() => normalizeCsv([header, sale.slice(1)]), /wrong number of columns/);
  assert.throws(() => normalizeCsv([sale]), /headers/);
});

test('rejects unusable or repeated FITIDs before import', () => {
  const row = { amount: -0.1, postedDate: '2026-01-01', fitid: 'fake-fitid' };
  for (const rows of [[{ ...row, fitid: undefined }], [{ ...row, fitid: '000' }], [row, row]]) {
    assert.throws(() => normalizeOfx(rows), /missing, all-zero or duplicate FITID/);
  }
  assert.equal(normalizeOfx([row])[0].imported_id, 'fake-fitid');
});

test('reports the installed API version on incompatible parser shapes without dumping rows', () => {
  assert.throws(() => validateParserResult('ofx', { errors: [], transactions: [{ secret: 'synthetic sensitive data' }] }),
    /Unsupported statement parser response from @actual-app\/api 26\.11\.0\./);
  assert.throws(() => validateParserResult('csv', { errors: [], transactions: [{ Amount: '0.10' }] }), /26\.11\.0/);
});

for (const [file, account, amounts] of [
  ['checking-synthetic.qfx', 'Synthetic Checking', [-10]],
  ['card-synthetic.qfx', 'Synthetic Card', [-10, 20]],
  ['checking-synthetic.csv', 'Synthetic Checking', [-10, 20]],
  ['card-synthetic.csv', 'Synthetic Card', [-10, -10, 20]],
] as const) {
  test(`Actual parses ${file}`, native, async () => {
    const result = await chase.parse(fixture(file), { routes });
    assert.equal(result.account, account);
    assert.deepEqual(result.rows.map(row => row.amountMinor), amounts);
    assert.match(result.rows[0].payee ?? '', /^Imaginary/);
    assert.equal(result.rows[0].postedDate, file.endsWith('.csv') ? '2026-11-16' : '2026-01-01');
  });
}

test('accepts missing ACCTID only with an explicit alias and parses .ofx', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chase-test-'));
  try {
    const path = join(directory, 'checking-synthetic.ofx');
    const contents = await readFile(fixture('checking-synthetic.qfx'), 'utf8');
    await writeFile(path, contents.replace('0000001234', ''));
    await assert.rejects(chase.parse(path, { routes }), /Supply --account explicitly/);
    const result = await chase.parse(path, { routes, alias: 'checking' });
    assert.equal(result.rows[0].imported_id, 'fake-qfx-1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects malformed date and amount tokens even if Actual normalizes them', native, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chase-test-'));
  try {
    const path = join(directory, 'checking.qfx');
    const contents = await readFile(fixture('checking-synthetic.qfx'), 'utf8');
    for (const input of [contents.replace('20260101120000', '20260231120000'), contents.replace('TRNAMT>-0.10', 'TRNAMT>-0.100000000000000001')]) {
      await writeFile(path, input);
      await assert.rejects(chase.parse(path, { routes }), /invalid amount|disagrees/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('imports posted rows from OFX with missing or malformed ledger fields', native, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chase-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'checking.qfx');
  const contents = await readFile(fixture('checking-synthetic.qfx'), 'utf8');
  for (const input of [
    contents.replace(/<LEDGERBAL>[^]*?<\/LEDGERBAL>/, ''),
    contents.replace('<BALAMT>50.00', '<BALAMT>'),
    contents.replace('</LEDGERBAL>', ''),
  ]) {
    await writeFile(path, input);
    const statement = await chase.parse(path, { routes });
    assert.equal(statement.balance, undefined);
    assert.equal(statement.rows.length, 1);
  }
});
