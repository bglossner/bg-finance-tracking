import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importIntoActual, parseImportRows, readImportConfig, readStatementImportConfig } from '../src/actual.js';
import { chase, parseAccounts } from '../src/importers/chase.js';

const row = { amountMinor: -123, postedDate: '2024-02-29', imported_id: 'fake-1', payee: 'Imaginary Shop' };
const env = {
  ACTUAL_SERVER_URL: 'http://actual-server:5006', ACTUAL_SERVER_PASSWORD: 'fake',
  ACTUAL_CACHE_DIR: '/actual-cache', ACTUAL_BUDGET_SYNC_ID: 'fake-budget',
  ACTUAL_ACCOUNTS: '{"checking":"fake-account"}',
};

test('validates normalized rows before Actual starts', () => {
  assert.deepEqual(parseImportRows(JSON.stringify([row])), [row]);
  for (const invalid of [
    [row, row], [{ ...row, postedDate: '2026-02-29' }], [{ ...row, amountMinor: 1.23 }],
    [{ ...row, postedDate: '0999-01-01' }], [{ ...row, imported_id: '' }],
    [{ ...row, imported_id: 'bgfin:starting-balance' }], [{ ...row, payee: 42 }], null,
  ]) {
    assert.throws(() => parseImportRows(JSON.stringify(invalid)));
  }
});

test('reconciles opening transactions and inclusive balances in Actual', {
  skip: process.env.BGFIN_CONTAINER_TESTS !== '1' && 'Requires the Docker job image',
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bgfin-actual-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const routes = parseAccounts(JSON.stringify({
    checking: { actualAccount: 'Test Checking', last4: '1234', filename: 'checking-*.qfx' },
    card: { actualAccount: 'Test Card', last4: '5678', filename: 'card-*.qfx' },
  }));
  const checking = await chase.parse('test/fixtures/checking-synthetic.qfx', { routes });
  const card = await chase.parse('test/fixtures/card-synthetic.qfx', { routes });
  const api = await import('@actual-app/api');
  const client = await api.init({ dataDir, verbose: false });
  try {
    // An offline budget exercises the pinned Actual engine with its native SQLite binding.
    await client.send('create-budget', { budgetName: 'Synthetic Reconciliation', avoidUpload: true });
    const checkingId = await api.createAccount({ name: checking.account, offbudget: false, closed: false });
    const cardId = await api.createAccount({ name: card.account, offbudget: false, closed: false }, -10);
    const inspectingApi = { ...api, init: async () => client, downloadBudget: async () => {}, sync: async () => {}, shutdown: async () => {} };
    const getRows = (accountId: string) => api.getTransactions(accountId, '', '');
    const opening = (rows: Awaited<ReturnType<typeof getRows>>) => rows.filter(row => row.starting_balance_flag);
    const [nativeOpening] = opening(await getRows(cardId));
    assert.ok(nativeOpening);
    // Same date and amount as the imported debit, so fuzzy matching would absorb it.
    await api.updateTransaction(nativeOpening.id, { date: '2026-01-01' });
    await api.addTransactions(checkingId, [{ date: '2026-01-03', amount: 8000, payee_name: 'Future' }]);
    const importFile = (statement: typeof checking, setStartingBalance: boolean, skipTransactions = false) =>
      importIntoActual(inspectingApi, readStatementImportConfig(env, statement.account), statement.rows, {
        balance: statement.balance, cutoff: '2026-01-01', setStartingBalance, skipTransactions,
      });

    assert.deepEqual(await importFile(checking, true), {
      added: 1, updated: 0, balanceCheck: { date: '2026-01-02', difference: 0n },
    });
    const [depositOpening] = opening(await getRows(checkingId));
    assert.equal(depositOpening.amount, 5010);
    assert.equal(depositOpening.date, '2025-12-31');
    assert.equal(depositOpening.imported_id, 'bgfin:starting-balance');

    assert.deepEqual(await importFile(card, true), {
      added: 2, updated: 0, balanceCheck: { date: '2026-01-02', difference: 0n },
    });
    const before = opening(await getRows(cardId));
    assert.equal(before.length, 1);
    assert.equal(before[0].id, nativeOpening.id);
    assert.equal(before[0].amount, -2015); // Includes the same-day +20-cent payment.
    assert.equal((await importFile(card, false)).added, 0);
    assert.deepEqual(opening(await getRows(cardId)), before);

    const later = { ...card, balance: { date: '2026-01-04', amountMinor: -2500 } };
    assert.deepEqual((await importFile(later, false)).balanceCheck, { date: '2026-01-04', difference: 495n });
    assert.deepEqual(opening(await getRows(cardId)), before);
    assert.deepEqual((await importFile(later, true, true)).balanceCheck, { date: '2026-01-04', difference: 0n });
    const after = opening(await getRows(cardId));
    assert.equal(after.length, 1);
    assert.equal(after[0].id, nativeOpening.id);
    assert.equal(after[0].amount, -2510);

    const otherOpening = { date: '2025-12-30', amount: 5, starting_balance_flag: true };
    await api.addTransactions(cardId, [otherOpening]);
    await assert.rejects(importFile(card, true), /Starting balance is ambiguous/);
    assert.equal(opening(await getRows(cardId)).length, 2);
  } finally {
    await api.shutdown();
  }
});

test('looks up only explicitly configured aliases', () => {
  assert.equal(readImportConfig(env, 'checking').accountId, 'fake-account');
  assert.throws(() => readImportConfig(env, 'constructor'), /Unknown account alias/);
  assert.throws(() => readImportConfig({ ...env, ACTUAL_SERVER_PASSWORD: '' }, 'checking'), /ACTUAL_SERVER_PASSWORD/);
});

test('passes stable IDs, syncs a successful import, and shuts down on failure', async () => {
  const calls: string[] = [];
  const config = readImportConfig({ ...env, ACTUAL_E2E_PASSWORD: 'fake-e2e' }, 'checking');
  let rejected = false;
  const api = {
    init: async () => { calls.push('init'); return {} as Awaited<ReturnType<typeof import('@actual-app/api').init>>; },
    downloadBudget: async (id: string, opts?: { password?: string }) => {
      assert.equal(id, 'fake-budget');
      assert.equal(opts?.password, 'fake-e2e');
      calls.push('download');
    },
    getAccounts: async () => [{ id: 'fake-account', name: 'Checking', closed: false, offbudget: false }],
    importTransactions: async (id: string, rows: unknown[]) => {
      assert.equal(id, 'fake-account');
      assert.deepEqual(rows, [{ account: 'fake-account', amount: -123, date: '2024-02-29', imported_id: 'fake-1', payee_name: 'Imaginary Shop' }]);
      calls.push('import');
      return { errors: rejected ? [{ message: 'fake' }] : [], added: ['fake-id'], updated: [], updatedPreview: [] };
    },
    sync: async () => { calls.push('sync'); },
    shutdown: async () => { calls.push('shutdown'); },
  };
  assert.deepEqual(await importIntoActual(api, config, [row]), { added: 1, updated: 0 });
  assert.deepEqual(calls.splice(0), ['init', 'download', 'import', 'sync', 'shutdown']);
  rejected = true;
  await assert.rejects(importIntoActual(api, config, [row]), /rejected/);
  assert.deepEqual(calls, ['init', 'download', 'import', 'shutdown']);
});
