import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const module = { exports: {} };
runInNewContext(read('../../userscripts/chase-qfx-download.user.js'), { module, URLSearchParams });
const { localToday, defaultRange, validRange, filename, accountListRequest, downloadRequest,
  maskedLabel, readAccounts, readCsrfToken, validateOfx } = module.exports;
const capture = JSON.parse(read('../../import-docs/chase/chase.json')).requests.map(entry => entry.request);
const from = '2024-02-27';
const to = '2024-03-02';
const id = 'synthetic&account=1';
const token = 'synthetic+/&token';
const account = { id, family: 'card' };

function assertRange(today, checkpoint, expectedStart) {
  const range = defaultRange(today, checkpoint);
  assert.equal(range.from, expectedStart);
  assert.equal(range.to, today);
}

test('first download defaults to 30 days before the local calendar day', () => {
  assert.equal(localToday(new Date(2024, 2, 2, 23, 59)), to);
  assertRange(to, undefined, '2024-02-01');
  assertRange(to, '2024-02-30', '2024-02-01');
  assertRange(to, '2024-03-03', '2024-02-01');
});

test('prior coverage overlaps by three calendar days across leap days and New Year', () => {
  assertRange('2024-03-08', to, '2024-02-28');
  assertRange('2025-01-08', '2025-01-02', '2024-12-30');
  assertRange('2025-03-12', '2025-03-10', '2025-03-07');
  assert.equal(validRange(from, from), true);
  assert.equal(validRange(to, from), false);
  assert.equal(validRange('2025-02-29', '2025-03-01'), false);
});

test('QFX names match exactly one example route and preserve legacy CSV globs', () => {
  const routes = Object.values(JSON.parse(read('../../config/accounts.example.json')));
  const realRoutes = Object.values(JSON.parse(read('../../ops/real/accounts.example.json')));
  for (const [index, csv] of ['checking-legacy.csv', 'card-legacy.csv'].entries()) {
    const route = routes[index];
    const name = filename(route.last4, from, to);
    assert.equal(name, `Chase${route.last4}_Activity_${from}_${to}.QFX`);
    assert.deepEqual(routes.filter(entry => matchesGlob(name, entry.filename)), [route]);
    assert.deepEqual(routes.filter(entry => matchesGlob(csv, entry.filename)), [route]);
    assert.equal(matchesGlob(name, realRoutes[index].filename.replace('XXXX', route.last4)), true);
  }
  assert.throws(() => filename('00001234', from, to), /invalid/i);
  assert.throws(() => filename('1234', to, from), /invalid/i);
});

test('account list is the observed empty-body form POST', () => {
  const request = accountListRequest();
  assert.equal(request.method === capture[0].method, true);
  assert.equal(request.path === new URL(capture[0].url).pathname, true);
  assert.equal(request.headers['Content-Type'] === capture[0].headers.find(header => header.name === 'content-type').value, true);
  assert.equal(request.body, undefined);
});

test('credit card download matches the observed GET and encodes account and CSRF parameters', () => {
  const request = downloadRequest(account, from, to, token);
  const url = new URL(request.path, 'https://secure.chase.com');
  const observed = new URL(capture[1].url);
  assert.equal(request.method === capture[1].method, true);
  assert.equal(url.pathname === observed.pathname, true);
  assert.equal([...url.searchParams.keys()].sort().join() === [...observed.searchParams.keys()].sort().join(), true);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    'digital-account-identifier': id, 'start-date': '20240227', 'end-date': '20240302',
    'account-activity-download-type-code': 'QFX', csrftoken: token, submit: 'Submit', 'eligibility-indicator': 'true',
  });
  for (const field of ['account-activity-download-type-code', 'submit', 'eligibility-indicator']) {
    assert.equal(url.searchParams.get(field) === observed.searchParams.get(field), true);
  }
  assert.equal(request.headers['Content-Type'] === capture[1].headers.find(header => header.name === 'content-type').value, true);
  assert.equal(request.body, undefined);
});

test('deposit download matches the observed form and sends its date fields in the correct order', () => {
  const request = downloadRequest({ id, family: 'deposit' }, from, to, token);
  const params = new URLSearchParams(request.body);
  const observed = new URLSearchParams(capture[2].formData);
  assert.equal(request.method === capture[2].method, true);
  assert.equal(request.path === new URL(capture[2].url).pathname, true);
  assert.equal(request.headers['Content-Type'] === capture[2].contentType, true);
  assert.equal([...params.keys()].sort().join() === [...observed.keys()].sort().join(), true);
  assert.deepEqual(Object.fromEntries(params), {
    transactionType: 'ALL', filterTranType: 'ALL', statementPeriodId: 'ALL', downloadType: 'QFX',
    accountId: id, dateHi: '20240302', dateLo: '20240227', csrftoken: token, submit: 'Submit',
  });
  for (const field of ['transactionType', 'filterTranType', 'statementPeriodId', 'downloadType', 'submit']) {
    assert.equal(params.get(field) === observed.get(field), true);
  }
  assert.throws(() => downloadRequest(account, from, to, ''), /invalid/i);
  assert.throws(() => downloadRequest({ id, family: 'other' }, from, to, token), /unsupported/i);
});

test('account selection follows deposit/card tile groups and extracts the fresh CSRF field by shape', () => {
  const payload = { cache: [
    { response: { csrfToken: token } },
    { response: { personalTileGroups: [{ depositAccountTileIds: ['a', 'c'], creditCardAccountTileIds: ['b'] }], accountTiles: [
      { tileId: 'a', accountId: 'opaque-a', accountTileDetailType: 'CHECKING', mask: '9999991234', nickname: '<b>Ignore</b>' },
      { tileId: 'b', accountId: 'opaque-b', mask: 'XXXX5678' },
      { tileId: 'c', accountId: 'opaque-c', mask: '9999', tileDetail: { closed: true } },
      { tileId: 'd', accountId: 'opaque-d', mask: '8888' },
    ] } },
  ] };
  const expected = [
    { id: 'opaque-a', family: 'deposit', last4: '1234', label: 'Checking …1234' },
    { id: 'opaque-b', family: 'card', last4: '5678', label: 'Credit card …5678' },
  ];
  assert.equal(JSON.stringify(readAccounts(payload)), JSON.stringify(expected));
  assert.equal(readCsrfToken(payload), token);
  assert.throws(() => readAccounts({ cache: [] }), /unfamiliar shape/i);
  assert.throws(() => readCsrfToken({ cache: [] }), /session token/i);
});

test('skips tiles without a usable account ID and keeps numeric and string IDs', () => {
  const accountTiles = [
    { tileId: 'missing' },
    { tileId: 'null', accountId: null },
    { tileId: 'object', accountId: {} },
    { tileId: 'boolean', accountId: false },
    { tileId: 'blank', accountId: ' ' },
    { tileId: 'number', accountId: 123 },
    { tileId: 'string', accountId: 'opaque' },
  ].map(tile => ({ ...tile, mask: 'XXXX5678' }));
  const personalTileGroups = [{ creditCardAccountTileIds: accountTiles.map(tile => tile.tileId) }];
  const accounts = readAccounts({ cache: [{ response: { accountTiles, personalTileGroups } }] });
  assert.equal(JSON.stringify(accounts.map(entry => entry.id)), '["123","opaque"]');
});

test('masked labels expose at most the last four digits and no arbitrary display text', () => {
  assert.equal(maskedLabel('deposit', 'SAVINGS', '9999 9999 9999 1234'), 'Savings …1234');
  assert.equal(maskedLabel('card', '<img src=x>', '**** 5678'), 'Credit card …5678');
  assert.equal(maskedLabel('deposit', '<b>Checking</b>', '<script>1234'), 'Deposit account');
  assert.equal(maskedLabel('card', 'CREDIT', '123'), 'Credit card');
});

const ok = '<STATUS><CODE>0\n<SEVERITY>INFO\n</STATUS>';
const signonResponse = status => `<SIGNONMSGSRSV1><SONRS>${status}<DTSERVER>20240302<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>`;
const signon = signonResponse(ok);
const cardResponse = body => `<CREDITCARDMSGSRSV1><CCSTMTTRNRS>${body}</CCSTMTTRNRS></CREDITCARDMSGSRSV1>`;
const transaction = '<STMTTRN><DTPOSTED>20240302</DTPOSTED><TRNAMT>-1.00</TRNAMT><FITID>fake-1</FITID></STMTTRN>';
const cardStatement = cardResponse(`${ok}<CCSTMTRS><CURDEF>USD</CURDEF>` +
  '<CCACCTFROM><ACCTID>XXXX5678</ACCTID></CCACCTFROM>' +
  `<BANKTRANLIST>${transaction}</BANKTRANLIST></CCSTMTRS>`);

function assertValidation(text, expected, ...args) {
  assert.deepEqual({ ...validateOfx(text, ...args) }, expected);
}

test('accepts both reference envelopes and a headerless statement', () => {
  assertValidation(read('../../import-docs/chase/credit-qfx.data'), { ok: true }, 'card', '5678');
  assertValidation(read('../../import-docs/chase/non-credit-qfx.data'), { ok: true }, 'deposit', '1234');
  assertValidation(`<OFX>${cardStatement}</OFX>`, { ok: true }, 'card', '5678', from, to);
  assertValidation(`<OFX>${cardStatement}</OFX>`, { ok: false, reason: 'wrong-family' }, 'deposit');
});

test('distinguishes a successful response without a statement or in-range transactions', () => {
  assertValidation(`<OFX>${signon}</OFX>`, { ok: false, reason: 'no-statement' }, 'card', '5678');
  assertValidation(`<OFX>${cardResponse(ok)}</OFX>`, { ok: false, reason: 'no-statement' }, 'card', '5678');
  assertValidation(`<OFX>${cardResponse(ok)}</OFX>`, { ok: false, reason: 'wrong-family' }, 'deposit');
  for (const statement of [
    cardStatement.replace(transaction, ''),
    cardStatement.replace(transaction, '<DTSTART>20240227\n<DTEND>20240302\n')
      .replace('</CCSTMTRS>', '<LEDGERBAL><BALAMT>0.00<DTASOF>20240302</LEDGERBAL></CCSTMTRS>'),
    cardStatement.replace(`<BANKTRANLIST>${transaction}</BANKTRANLIST>`, ''),
    cardStatement.replace('20240302', '20240303'),
    cardStatement.replace('20240302', '20240226'),
  ]) {
    assertValidation(`<OFX>${statement}</OFX>`, { ok: false, reason: 'no-transactions' }, 'card', '5678', from, to);
  }
  assertValidation(`<OFX>${cardStatement.replace('20240302', '20240227')}</OFX>`, { ok: true }, 'card', '5678', from, to);
  assertValidation(`<OFX>${cardStatement.replace(transaction, '')}</OFX>`, { ok: false, reason: 'wrong-account' }, 'card', '1234');
});

test('rejects HTML, JSON and incomplete OFX envelopes', () => {
  for (const response of [
    '<!doctype html><h1>Sign in</h1>', '{"error":"session expired"}', 'OFXHEADER:100\n<html>Sign in</html>',
    `OFXHEADER:100\n<html><OFX>${cardStatement}</OFX>`, `<OFX>${cardStatement}`, `<OFX>${cardStatement}</OFX>junk`,
    `<OFX>${signon}<UNKNOWN></UNKNOWN></OFX>`,
    `<OFX>${signon.replace('</SONRS>', '<HTML></HTML></SONRS>')}</OFX>`,
    `<OFX>${cardResponse(`${ok}<HTML></HTML>`)}</OFX>`,
    `<OFX>${cardStatement.replace('<CCSTMTRS>', '<OTHER><CCSTMTRS>').replace('</CCSTMTRS>', '</CCSTMTRS></OTHER>')}</OFX>`,
    `<OFX>${cardResponse(`${ok}<CCSTMTRS></CCSTMTRS>`)}</OFX>`,
    `<OFX>${cardResponse(`${ok}<CCSTMTRS />`)}</OFX>`,
    `<OFX>${cardStatement.replace(ok, '')}</OFX>`,
    `<OFX>${cardStatement.replace('</STMTTRN>', '')}</OFX>`,
    `<OFX>${cardStatement.replace('</BANKTRANLIST>', '')}</OFX>`,
    `<OFX>${cardStatement.replace(transaction, '<HTML></HTML>')}</OFX>`,
    `<OFX>${cardStatement.replace(transaction, `<OTHER>${transaction}</OTHER>`)}</OFX>`,
    `<OFX>${cardStatement.replace(`<BANKTRANLIST>${transaction}</BANKTRANLIST>`, '<HTML></HTML>')}</OFX>`,
    `<OFX>${cardStatement.replace('</BANKTRANLIST>', '</BANKTRANLIST><HTML>')}</OFX>`,
    `<OFX>${cardStatement.replace('20240302', '20240230')}</OFX>`,
    `<OFX>${cardStatement.replace(transaction, '<!-- <STMTTRN></STMTTRN> -->')}</OFX>`,
  ]) {
    assertValidation(response, { ok: false, reason: 'not-ofx' });
  }
  assertValidation(`<OFX>${cardStatement}${cardStatement}</OFX>`, { ok: false, reason: 'multiple-statements' });
});

test('reports only the numeric OFX error code, including errors without a statement', () => {
  for (const [badStatus, code] of [
    ['<STATUS><CODE>15500\n<SEVERITY>ERROR\n<MESSAGE>Private details\n</STATUS>', 15500],
    ['<STATUS><CODE>0</CODE><SEVERITY>ERROR</SEVERITY></STATUS>', 0],
    ['<STATUS><CODE>2000<SEVERITY>WARN</STATUS>', 2000],
  ]) {
    assertValidation(`<OFX>${cardResponse(badStatus)}</OFX>`, { ok: false, reason: 'status-error', code });
    assertValidation(`<OFX>${signonResponse(badStatus)}${cardStatement}</OFX>`, { ok: false, reason: 'status-error', code });
    assertValidation(`<OFX><HTML>${badStatus}</HTML></OFX>`, { ok: false, reason: 'not-ofx' });
  }
  for (const badStatus of [
    '<STATUS><CODE>0', '<STATUS><CODE>0<CODE>1</STATUS>',
    '<STATUS><CODE>0<SEVERITY>UNKNOWN</STATUS>',
    '<STATUS><CODE>123456789<SEVERITY>ERROR</STATUS>',
    '<STATUS><CODE>15500 payload<SEVERITY>ERROR</STATUS>',
    '<STATUS><CODE>0<SEVERITY>INFO<HTML></HTML></STATUS>',
  ]) {
    assertValidation(`<OFX>${signonResponse(badStatus)}${cardStatement}</OFX>`, { ok: false, reason: 'not-ofx' });
  }
});

test('a downloaded OFX must identify the same account suffix as the selected row', () => {
  const ofx = `<OFX>${cardStatement}</OFX>`;
  const mismatch = { ok: false, reason: 'wrong-account' };
  assertValidation(ofx, { ok: true }, 'card', '5678');
  assertValidation(ofx, mismatch, 'card', '1234');
  assertValidation(ofx.replace('<ACCTID>XXXX5678</ACCTID>', ''), mismatch, 'card', '5678');
  assertValidation(ofx.replace('</CCSTMTRS>', '<ACCTID>XXXX5678</ACCTID></CCSTMTRS>'), mismatch, 'card', '5678');
});

for (const [identifier, expectedLast4, accepted] of [
  ['12345678', '5678', true],
  ['12345678-9012', '9012', true],
  ['12345678-9012', '5678', false],
  ['Xx**5678', '5678', true],
  ['Xx**-5678', '5678', true],
  ['12345678-05678', '5678', false],
  ['12345678-678', '5678', false],
  ['1234-56-5678', '5678', false],
  ['-5678', '5678', false],
  ['ID5678', '5678', false],
  ['', '5678', false],
]) {
  test(`checks the selected suffix for synthetic ACCTID ${JSON.stringify(identifier)} against ${expectedLast4}`, () => {
    const ofx = `<OFX>${cardStatement.replace('XXXX5678', identifier)}</OFX>`;
    assertValidation(ofx, accepted ? { ok: true } : { ok: false, reason: 'wrong-account' }, 'card', expectedLast4);
  });
}

test('characterizes a month-end default and an inclusive single-day filename', () => {
  const today = '2024-03-31';
  assertRange(today, null, '2024-03-01');
  assertRange(today, today, '2024-03-28');
  assert.equal(filename('0012', today, today), 'Chase0012_Activity_2024-03-31_2024-03-31.QFX');
});

test('characterizes exact card URL and deposit form serialization', () => {
  const card = downloadRequest(account, from, to, token);
  assert.equal(new URL(card.path, 'https://secure.chase.com').href,
    'https://secure.chase.com/svc/rr/accounts/secure/gateway/credit-card/transactions/inquiry-maintenance/digital-transaction-activity/v1/transaction-activities' +
    '?digital-account-identifier=synthetic%26account%3D1&start-date=20240227&end-date=20240302&' +
    'account-activity-download-type-code=QFX&csrftoken=synthetic%2B%2F%26token&submit=Submit&eligibility-indicator=true');
  assert.equal(card.headers.Accept, 'application/json, text/plain, */*');

  const deposit = downloadRequest({ id, family: 'deposit' }, from, to, token);
  assert.equal(new URL(deposit.path, 'https://secure.chase.com').href,
    'https://secure.chase.com/svc/rr/accounts/secure/v1/account/activity/download/dda/list');
  assert.equal(deposit.body, 'transactionType=ALL&filterTranType=ALL&statementPeriodId=ALL&downloadType=QFX&' +
    'accountId=synthetic%26account%3D1&dateHi=20240302&dateLo=20240227&csrftoken=synthetic%2B%2F%26token&submit=Submit');
});

test('characterizes numeric zero, duplicate account IDs and masked types', () => {
  const personalTileGroups = [{ depositAccountTileIds: [1, 2], creditCardAccountTileIds: [2, 3, 4] }];
  const accountTiles = [
    { tileId: 1, accountId: 0, accountTileDetailType: 'savings', mask: '••0012' },
    { tileId: 2, accountId: 'ambiguous', mask: 'XXXX5678' },
    { tileId: 3, accountId: '0', mask: 'XXXX5678' },
    { tileId: 4, accountId: 'opaque', mask: '*x-5678', nickname: 'Ignored nickname' },
  ];
  const payload = { cache: [{ response: { accountTiles, personalTileGroups } }] };
  assert.equal(JSON.stringify(readAccounts(payload)), JSON.stringify([
    { id: '0', family: 'deposit', last4: '0012', label: 'Savings …0012' },
    { id: 'opaque', family: 'card', last4: '5678', label: 'Credit card …5678' },
  ]));
});

test('characterizes the deposit fixture with an explicit account suffix', () => {
  const deposit = read('../../import-docs/chase/non-credit-qfx.data');
  const explicitSuffix = deposit.replace(/<ACCTID>[^<\r\n]+/, '<ACCTID>12345678-9012');
  assertValidation(deposit, { ok: false, reason: 'wrong-family' }, 'card', '1234');
  assertValidation(explicitSuffix, { ok: true }, 'deposit', '9012');
  assertValidation(explicitSuffix, { ok: false, reason: 'wrong-account' }, 'deposit', '5678');
});
