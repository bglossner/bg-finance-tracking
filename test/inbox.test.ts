import assert from 'node:assert/strict';
import { lutimes, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runInbox } from '../src/inbox.js';
import { parseAccounts } from '../src/importers/chase.js';
import { loadAccounts, privateDirectory, saveAccounts, withIntakeLock } from '../src/state/intake-state.js';

const now = new Date('2026-01-20T00:00:00Z');
const old = new Date('2026-01-01T00:00:00Z');
const routes = parseAccounts(JSON.stringify({
  checking: { actualAccount: 'Synthetic Checking', last4: '1234', filename: 'checking-*' },
  card: { actualAccount: 'Synthetic Card', last4: '5678', filename: 'card-*' },
}));
const fixture = (name: string) => readFile(`test/fixtures/${name}`);

async function setup(t: TestContext) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bgfin-inbox-test-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const inbox = await privateDirectory(join(dataRoot, 'inbox'));
  const reports: string[] = [];
  const warnings: string[] = [];
  const calls: string[] = [];
  const options: Parameters<typeof runInbox>[0] = {
    dataRoot, repository: process.cwd(), routes, cutoff: '2025-06-01', minimumAgeSeconds: 10, staleDays: 10, now,
    report: message => reports.push(message), warn: message => warnings.push(message),
    async importRows(account) { calls.push(account); return { added: 1, updated: 0 }; },
    async parseRows(contents) {
      const postedDate = /<DTPOSTED>(\d{4})(\d{2})(\d{2})/.exec(contents.toString())?.slice(1).join('-') ?? '2026-01-02';
      return [{ postedDate, amountMinor: 10, imported_id: 'synthetic' }];
    },
  };
  async function drop(name: string, bytes: Buffer | string, date = old) {
    const path = join(inbox, name);
    await writeFile(path, bytes);
    await utimes(path, date, date);
  }
  const state = join(dataRoot, 'state');
  const quarantine = join(dataRoot, 'quarantine');
  async function reasons() {
    return Promise.all((await readdir(quarantine)).filter(name => name.endsWith('.reason.txt'))
      .map(name => readFile(join(quarantine, name), 'utf8')));
  }
  return { dataRoot, inbox, reports, warnings, calls, options, drop, state, reasons };
}

test('routes a subdirectory, routes by ACCTID, and quarantines conflicting or unknown routes', async t => {
  const env = await setup(t);
  await privateDirectory(join(env.inbox, 'checking'));
  await env.drop('checking/card-wins-by-directory.csv', 'synthetic csv');
  await env.drop('opaque.QFX', await fixture('card-synthetic.qfx'));
  await env.drop('checking-conflict.qfx', await fixture('card-synthetic.qfx'));
  await env.drop('unmatched.csv', 'synthetic csv');
  await env.drop('checking/wrong.qfx', await fixture('card-synthetic.qfx'));
  assert.equal(await runInbox(env.options), true);
  assert.deepEqual(env.calls, ['Synthetic Checking', 'Synthetic Card']);
  assert.deepEqual((await env.reasons()).sort(), [
    'Ambiguous statement account.\n', 'Statement account conflicts with the selected alias.\n', 'Unmatched statement account.\n',
  ]);
});

test('ignores temporary and recent files and quarantines junk and links without reading their targets', async t => {
  const env = await setup(t);
  for (const suffix of ['crdownload', 'part', 'download', 'TMP']) await env.drop(`checking.qfx.${suffix}`, 'partial');
  await env.drop('checking-recent.qfx', 'partial', now);
  await env.drop('junk.exe', 'junk');
  const target = join(env.dataRoot, 'outside');
  await writeFile(target, 'outside');
  await symlink(target, join(env.inbox, 'checking-link.csv'));
  await lutimes(join(env.inbox, 'checking-link.csv'), old, old);
  assert.equal(await runInbox(env.options), true);
  assert.deepEqual((await env.reasons()).sort(), ['Symbolic links are not accepted.\n', 'Unsupported file extension.\n']);
  assert.equal(await readFile(target, 'utf8'), 'outside');
  assert.deepEqual(await readdir(env.inbox), ['checking-recent.qfx', 'checking.qfx.TMP', 'checking.qfx.crdownload', 'checking.qfx.download', 'checking.qfx.part']);
  assert.deepEqual(env.calls, []);
});

test('imports chronological jobs and archives exact duplicate hashes without resending', async t => {
  const env = await setup(t);
  const initial = await fixture('checking-synthetic.qfx');
  const later = Buffer.from(initial.toString().replaceAll('20260101', '20260106'));
  await env.drop('a.qfx', later);
  await env.drop('z.qfx', initial);
  const posted: string[] = [];
  env.options.importRows = async (_, rows) => { posted.push(rows[0].postedDate); return { added: 1, updated: 0 }; };
  assert.equal(await runInbox(env.options), true);
  assert.deepEqual(posted, ['2026-01-01', '2026-01-06']);
  await env.drop('another-name.qfx', initial);
  assert.equal(await runInbox(env.options), true);
  assert.equal(posted.length, 2);
  assert.match(env.reports.at(-2)!, /1 files processed \(1 duplicates\), 0 added, 0 updated, 1 skipped.*next export from: 2026-01-03/);
  const archived = await readdir(join(env.dataRoot, 'archive/checking/2026'));
  assert.equal(archived.length, 3);
  assert.equal(archived.filter(name => name.includes('-duplicate-')).length, 1);
});

test('continues other accounts after an ambiguous failure and advances only successful checkpoints', async t => {
  const env = await setup(t);
  await env.drop('one.qfx', await fixture('checking-synthetic.qfx'));
  await env.drop('two.qfx', await fixture('card-synthetic.qfx'));
  const accept = env.options.importRows;
  env.options.importRows = async (account, rows) => {
    if (account === 'Synthetic Checking') throw new Error('ambiguous sync with sensitive payload');
    return accept(account, rows);
  };
  assert.equal(await runInbox(env.options), false);
  assert.deepEqual(await readdir(env.inbox), ['one.qfx']);
  let accounts = await loadAccounts(env.state, env.options.warn);
  assert.equal(accounts.has('checking'), false);
  assert.ok(accounts.get('card')?.latestPostedDate);
  assert.match(env.reports[0], /latest posted: none, next export from: 2025-06-01/);
  assert.ok(env.warnings.every(message => !message.includes('sensitive')));
  assert.equal(await runInbox({ ...env.options, importRows: accept }), true);
  accounts = await loadAccounts(env.state, env.options.warn);
  assert.equal(accounts.get('checking')?.latestPostedDate, '2026-01-01');
  assert.equal(accounts.get('checking')?.lastRun, now.toISOString());
});

test('atomically replaces private state and recovers missing and corrupt files', async t => {
  const env = await setup(t);
  await privateDirectory(env.state);
  assert.equal((await loadAccounts(env.state, env.options.warn)).size, 0);
  const path = join(env.state, 'accounts.json');
  await writeFile(path, '{', { mode: 0o600 });
  assert.equal((await loadAccounts(env.state, env.options.warn)).size, 0);
  const [corrupt] = await readdir(env.state);
  assert.match(corrupt, /^accounts\.corrupt-.*\.json$/);
  assert.equal(await readFile(join(env.state, corrupt), 'utf8'), '{');
  await saveAccounts(env.state, new Map());
  const before = await stat(path);
  const next = new Map([['checking', { lastRun: now.toISOString(), importedHashes: ['a'.repeat(64)] }]]);
  await saveAccounts(env.state, next);
  const after = await stat(path);
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o600);
  assert.deepEqual(await loadAccounts(env.state, env.options.warn), next);
  assert.deepEqual((await readdir(env.state)).sort(), [corrupt, 'accounts.json'].sort());
});

test('rejects concurrent intake and clears stale PID records without signalling', async t => {
  const env = await setup(t);
  await privateDirectory(env.state);
  const path = join(env.state, 'import.lock');
  await writeFile(path, '99999999\n', { mode: 0o600 });
  await withIntakeLock(env.state, async () => {
    assert.equal(await readFile(path, 'utf8'), `${process.pid}\n`);
    await assert.rejects(withIntakeLock(env.state, async () => assert.fail('lock reentered')), /lock is held/);
  });
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('parses checking and card QFX dropped together in the container', { skip: !process.env.BGFIN_CONTAINER_TESTS }, async t => {
  const env = await setup(t);
  await env.drop('one.QFX', await fixture('checking-synthetic.qfx'));
  await env.drop('two.OfX', await fixture('card-synthetic.qfx'));
  assert.equal(await runInbox({ ...env.options, parseRows: undefined, async importRows(account, rows) {
    env.calls.push(account);
    return { added: rows.length, updated: 0 };
  } }), true);
  assert.deepEqual(env.calls, ['Synthetic Checking', 'Synthetic Card']);
  assert.match(env.reports[0], /1 added.*next export from: 2025-12-29/);
  assert.match(env.reports[1], /2 added.*next export from:/);
  assert.deepEqual(await readdir(env.inbox), []);
});
