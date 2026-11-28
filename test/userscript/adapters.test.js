import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const generated = readFileSync(new URL('../../userscripts/chase-qfx-download.user.js', import.meta.url), 'utf8');
const module = { exports: {} };
runInNewContext(generated, { module, URLSearchParams, TextEncoder, crypto: webcrypto, navigator });
const { chaseAdapter, createDateMemory, defaultRange } = module.exports;

const accountId = 'synthetic-checking-id';
const legacyPrefix = 'bgfin.chase-qfx.v1.';
const suffix = createHash('sha256').update(legacyPrefix + accountId).digest('hex');
const legacyKey = legacyPrefix + suffix;
const currentKey = 'bgfin.userscript.chase.v1.date.' + suffix;

function dateStorage(entries, writeError) {
  const values = new Map(entries);
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      if (writeError) throw writeError;
      values.set(key, value);
    },
  };
}

const payload = { cache: [
  { response: { csrfToken: 'synthetic-token' } },
  { response: {
    personalTileGroups: [{ depositAccountTileIds: ['checking'] }],
    accountTiles: [{ tileId: 'checking', accountId, accountTileDetailType: 'CHECKING', mask: 'XXXX1234' }],
  } },
] };

function accountListContext() {
  return { request(spec) {
    assert.equal(spec.method, 'POST');
    assert.equal(spec.headers['x-jpmc-csrf-token'], 'NONE');
    return { ok: true, json: async () => payload };
  } };
}

test('a Chase row uses the original key and carries forward its last confirmed date', async () => {
  const [account] = await chaseAdapter.listAccounts(accountListContext());
  assert.equal(account.key, suffix);
  const storage = dateStorage([[legacyKey, '2025-01-02']]);
  const memory = createDateMemory(chaseAdapter, () => storage);
  assert.deepEqual({ ...defaultRange('2025-01-08', await memory.read(account.key)) }, {
    from: '2024-12-30', to: '2025-01-08',
  });
  assert.deepEqual([...storage.values], [[legacyKey, '2025-01-02'], [currentKey, '2025-01-02']]);
  assert.equal(await memory.save(account.key, '2024-12-30'), true);
  assert.equal(storage.getItem(currentKey), '2025-01-02');
  assert.equal(await memory.save(account.key, '2025-01-04'), true);
  storage.values.set(legacyKey, '2025-01-03');
  assert.equal(await memory.read(account.key), '2025-01-04');
  storage.values.set(legacyKey, '2025-01-05');
  assert.equal(await memory.read(account.key), '2025-01-05');
  assert.equal(storage.getItem(currentKey), '2025-01-05');
  assert.equal(await createDateMemory({ id: 'other' }, () => storage).read(account.key), null);
});

test('migration and confirmation serialize updates across tabs', async () => {
  const storage = dateStorage([[legacyKey, '2025-01-02']]);
  const left = createDateMemory(chaseAdapter, () => storage, navigator.locks);
  const right = createDateMemory(chaseAdapter, () => storage, navigator.locks);
  const getItem = storage.getItem;
  let confirmation;
  storage.getItem = key => {
    const value = getItem(key);
    if (key === currentKey && !confirmation) {
      storage.getItem = getItem;
      confirmation = right.save(suffix, '2025-01-04');
    }
    return value;
  };

  assert.equal(await left.read(suffix), '2025-01-02');
  assert.equal(await confirmation, true);
  assert.equal(storage.getItem(currentKey), '2025-01-04');
});

test('migration ignores malformed dates and honors legacy coverage when writes fail', async () => {
  const storage = dateStorage([[legacyKey, '2025-02-30']]);
  const memory = createDateMemory(chaseAdapter, () => storage);
  assert.equal(await memory.read(suffix), null);
  assert.equal(storage.getItem(currentKey), null);

  const readOnly = dateStorage([[legacyKey, '2025-01-02']], new Error('storage full'));
  const readOnlyMemory = createDateMemory(chaseAdapter, () => readOnly);
  assert.equal(await readOnlyMemory.read(suffix), '2025-01-02');
  assert.equal(await readOnlyMemory.save(suffix, '2025-01-03'), false);
  assert.equal(readOnly.getItem(currentKey), null);
  assert.equal(readOnly.getItem(legacyKey), '2025-01-02');
});

test('existing coverage can still be read if Web Locks is unavailable or rejected', async () => {
  const rejectedLocks = { request: async () => { throw new Error('Lock denied'); } };
  for (const locks of [null, rejectedLocks]) {
    const storage = dateStorage([[legacyKey, '2025-01-02']]);
    const memory = createDateMemory(chaseAdapter, () => storage, locks);
    assert.equal(await memory.read(suffix), '2025-01-02');
    assert.equal(storage.getItem(currentKey), null);
  }
});

test('Chase refreshes its token against current accounts before building a download request', async () => {
  const context = accountListContext();
  const [account] = await chaseAdapter.listAccounts(context);
  await assert.rejects(chaseAdapter.getSessionToken(context, { ...account, last4: '9876' }), /account list has changed/);
  const token = await chaseAdapter.getSessionToken(context, account);
  const from = '2025-01-01';
  const to = '2025-01-02';
  const deposit = chaseAdapter.buildDownloadRequest(account, from, to, token);
  const card = chaseAdapter.buildDownloadRequest({ ...account, family: 'card' }, from, to, token);
  assert.equal(deposit.headers['x-jpmc-csrf-token'], 'NONE');
  assert.equal(new URLSearchParams(deposit.body).get('csrftoken'), 'synthetic-token');
  assert.equal(card.headers['x-jpmc-csrf-token'], undefined);
  assert.equal(new URL(card.path, chaseAdapter.origins[0]).searchParams.get('csrftoken'), 'synthetic-token');
});

test('generated Chase metadata preserves its installation identity and dashboard scope', () => {
  const metadata = generated.slice(0, generated.indexOf('// ==/UserScript=='));
  const directives = metadata.match(/^\/\/ @(?!version\s).*$/gm);
  assert.deepEqual(directives, [
    '// @name         Chase QFX downloads',
    '// @description  Download Chase activity as QFX from the signed-in dashboard.',
    '// @match        https://secure.chase.com/web/auth/dashboard',
    '// @grant        none',
    '// @noframes',
    '// @run-at       document-idle',
  ]);
});

test('the browser entry point ignores other origins, off-dashboard routes, and frames', () => {
  for (const [url, frame] of [
    ['https://secure.chase.com.example.invalid/web/auth/dashboard', false],
    ['https://secure.chase.com:8443/web/auth/dashboard', false],
    ['http://secure.chase.com/web/auth/dashboard', false],
    ['https://secure.chase.com/web/auth/dashboard-other', false],
    ['https://secure.chase.com/web/auth/dashboard', true],
  ]) {
    const window = {};
    window.top = frame ? {} : window;
    runInNewContext(generated, {
      window, location: new URL(url),
      get document() { assert.fail('The script tried to mount on an excluded page.'); },
      get fetch() { assert.fail('The script tried to fetch on an excluded page.'); },
    });
  }
});

test('installed userscripts match the generator output', () => {
  const generator = fileURLToPath(new URL('../../userscripts/build.mjs', import.meta.url));
  execFileSync(process.execPath, [generator, '--check'], { stdio: 'pipe' });
});
