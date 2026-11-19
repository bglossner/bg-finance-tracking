import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIntoActual, parseImportRows, readImportConfig } from '../src/actual.js';

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
    [{ ...row, postedDate: '0999-01-01' }], [{ ...row, imported_id: '' }], [{ ...row, payee: 42 }], null,
  ]) {
    assert.throws(() => parseImportRows(JSON.stringify(invalid)));
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
