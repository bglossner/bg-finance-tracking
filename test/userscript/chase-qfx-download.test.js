import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const module = { exports: {} };
runInNewContext(read('../../userscripts/chase-qfx-download.user.js'), { module, URLSearchParams });
const { localToday, defaultRange, validRange, filename, accountListRequest, downloadRequest,
  maskedLabel, readAccounts, readCsrfToken, isOfx } = module.exports;
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

test('masked labels expose at most the last four digits and no arbitrary display text', () => {
  assert.equal(maskedLabel('deposit', 'SAVINGS', '9999 9999 9999 1234'), 'Savings …1234');
  assert.equal(maskedLabel('card', '<img src=x>', '**** 5678'), 'Credit card …5678');
  assert.equal(maskedLabel('deposit', '<b>Checking</b>', '<script>1234'), 'Deposit account');
  assert.equal(maskedLabel('card', 'CREDIT', '123'), 'Credit card');
});

const ok = '<STATUS><CODE>0\n<SEVERITY>INFO\n</STATUS>';
const emptyCardStatement = `<CREDITCARDMSGSRSV1><CCSTMTTRNRS>${ok}<CCSTMTRS><CURDEF>USD</CURDEF>` +
  '<CCACCTFROM><ACCTID>XXXX5678</ACCTID></CCACCTFROM><BANKTRANLIST></BANKTRANLIST>' +
  '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>';

test('accepts both reference envelopes and a headerless statement with no transactions', () => {
  assert.equal(isOfx(read('../../import-docs/chase/credit-qfx.data'), 'card'), true);
  assert.equal(isOfx(read('../../import-docs/chase/non-credit-qfx.data'), 'deposit'), true);
  assert.equal(isOfx(`<OFX>${emptyCardStatement}</OFX>`, 'card'), true);
  assert.equal(isOfx(`<OFX>${emptyCardStatement}</OFX>`, 'deposit'), false);
});

test('rejects HTML, JSON and incomplete OFX envelopes', () => {
  for (const response of [
    '<!doctype html><h1>Sign in</h1>', '{"error":"session expired"}', 'OFXHEADER:100\n<html>Sign in</html>',
    `OFXHEADER:100\n<html><OFX>${emptyCardStatement}</OFX>`, `<OFX>${emptyCardStatement}`, `<OFX>${emptyCardStatement}</OFX>junk`,
    `<OFX><SIGNONMSGSRSV1><SONRS>${ok}</SONRS></SIGNONMSGSRSV1></OFX>`,
    `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS>${ok}<CCSTMTRS></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`,
    `<OFX>${emptyCardStatement}${emptyCardStatement}</OFX>`,
  ]) {
    assert.equal(isOfx(response), false);
  }
});

test('rejects OFX error statuses, including errors outside the statement', () => {
  for (const badStatus of [
    '<STATUS><CODE>15500\n<SEVERITY>ERROR\n</STATUS>', '<STATUS><CODE>0<SEVERITY>ERROR</STATUS>',
    '<STATUS><CODE>0', '<STATUS><CODE>0<CODE>1</STATUS>',
  ]) {
    assert.equal(isOfx(`<OFX>${emptyCardStatement}${badStatus}</OFX>`), false);
  }
});

test('a downloaded OFX must identify the same account suffix as the selected row', () => {
  const ofx = `<OFX>${emptyCardStatement}</OFX>`;
  assert.equal(isOfx(ofx, 'card', '5678'), true);
  assert.equal(isOfx(ofx, 'card', '1234'), false);
  assert.equal(isOfx(ofx.replace('<ACCTID>XXXX5678</ACCTID>', ''), 'card', '5678'), false);
  assert.equal(isOfx(ofx.replace('</CCSTMTRS>', '<ACCTID>XXXX5678</ACCTID></CCSTMTRS>'), 'card', '5678'), false);
});
