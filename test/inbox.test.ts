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
    dataRoot, repository: process.cwd(), routes, cutoff: '2025-06-01', budgetIdentity: 'synthetic-budget', minimumAgeSeconds: 10, staleDays: 10, now,
    report: message => reports.push(message), warn: message => warnings.push(message), showBalanceDifference: true,
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
  async function pending() {
    const directory = join(inbox, '.processing');
    return (await Promise.all((await readdir(directory)).map(name => readdir(join(directory, name))))).flat().sort();
  }
  return { dataRoot, inbox, reports, warnings, calls, options, drop, state, reasons, pending };
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
  assert.deepEqual(await readdir(env.inbox), ['.processing', 'checking-recent.qfx', 'checking.qfx.TMP', 'checking.qfx.crdownload', 'checking.qfx.download', 'checking.qfx.part']);
  assert.deepEqual(env.calls, []);
});

test('QFX-only intake accepts uppercase QFX and quarantines other formats before parsing', async t => {
  const env = await setup(t);
  await env.drop('checking-synthetic.QFX', await fixture('checking-synthetic.qfx'));
  await env.drop('card-synthetic.ofx', await fixture('card-synthetic.qfx'));
  await env.drop('card-synthetic.csv', 'synthetic csv');
  assert.equal(await runInbox({ ...env.options, acceptedExtensions: ['.qfx'] }), true);
  assert.deepEqual(env.calls, ['Synthetic Checking']);
  assert.deepEqual(await env.reasons(), ['Unsupported file extension.\n', 'Unsupported file extension.\n']);
});

test('reports an incorrect Actual balance after importing a statement with LEDGERBAL', async t => {
  const env = await setup(t);
  let actualBalance = 4990; // Synthetic existing balance before the new ten-cent debit.
  env.options.importRows = async () => ({ added: 1, updated: 0 });
  await env.drop('checking-history.csv', 'prior synthetic import');
  assert.equal(await runInbox(env.options), true);
  assert.ok(env.reports.includes('checking: balance check: skipped (CSV has no statement balance).'));

  env.options.importRows = async (_, __, { balance, setStartingBalance }) => {
    actualBalance -= 10;
    assert.ok(balance);
    assert.equal(setStartingBalance, false);
    return { added: 1, updated: 0, balanceCheck: { date: balance.date, difference: BigInt(actualBalance - balance.amountMinor) } };
  };
  await env.drop('checking-current.qfx', await fixture('checking-synthetic.qfx'));
  assert.equal(await runInbox(env.options), true);
  assert.equal(actualBalance, 4980);
  assert.match(env.reports.join('\n'), /checking: balance check: off by -0\.20 as of 2026-01-02/);
  assert.match(env.reports.join('\n'), /--set-starting-balance checking/);
  const saved = JSON.parse(await readFile(join(env.state, 'accounts.json'), 'utf8'));
  assert.deepEqual(saved.checking.lastBalanceCheck, { status: 'mismatch', date: '2026-01-02' });
  assert.doesNotMatch(JSON.stringify(saved), /5000|4980|difference/);
});

test('imports chronological jobs and archives exact duplicate hashes without resending', async t => {
  const env = await setup(t);
  const initial = await fixture('checking-synthetic.qfx');
  const later = Buffer.from(initial.toString().replaceAll('20260101', '20260106'));
  await env.drop('a.qfx', later);
  await env.drop('z.qfx', initial);
  const posted: string[] = [];
  env.options.importRows = async (_, rows, statement) => {
    if (!statement.skipTransactions) posted.push(rows[0].postedDate);
    return { added: statement.skipTransactions ? 0 : 1, updated: 0 };
  };
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

test('rebases only the selected alias using its newest ledger, including an exact re-drop', async t => {
  const env = await setup(t);
  const checking = await fixture('checking-synthetic.qfx');
  const older = checking.toString().replace('<DTASOF>20260102</LEDGERBAL>', '<DTASOF>20260101</LEDGERBAL>');
  const card = await fixture('card-synthetic.qfx');
  const checks: { account: string; date?: string; set: boolean; replay: boolean }[] = [];
  env.options.importRows = async (account, _, { balance, setStartingBalance, skipTransactions }) => {
    checks.push({ account, date: balance?.date, set: setStartingBalance, replay: skipTransactions });
    return { added: skipTransactions ? 0 : 1, updated: 0,
      balanceCheck: balance && { date: balance.date, difference: 0n } };
  };
  await env.drop('checking-newest.qfx', checking);
  await env.drop('card-current.qfx', card);
  assert.equal(await runInbox(env.options), true);
  assert.deepEqual(checks.splice(0).map(check => check.set), [true, true]);

  await env.drop('checking-newest.qfx', checking);
  await env.drop('checking-older.qfx', older);
  await env.drop('card-current.qfx', card);
  assert.equal(await runInbox({ ...env.options, setStartingBalance: 'checking' }), true);
  assert.deepEqual(checks, [
    { account: 'Synthetic Checking', date: '2026-01-01', set: false, replay: false },
    { account: 'Synthetic Checking', date: '2026-01-02', set: true, replay: true },
    { account: 'Synthetic Card', date: '2026-01-02', set: false, replay: true },
  ]);
  const state = await loadAccounts(env.state, env.options.warn);
  assert.deepEqual(state.get('checking')?.lastBalanceCheck, { status: 'ok', date: '2026-01-02' });
  assert.equal(state.get('checking')?.importedHashes.length, 2);
  assert.equal(await runInbox({ ...env.options, setStartingBalance: 'checking' }), false);
  assert.ok(env.warnings.some(message => message.includes('starting balance was not set')));
});

test('continues other accounts after an ambiguous failure and advances only successful checkpoints', async t => {
  const env = await setup(t);
  await env.drop('one.qfx', await fixture('checking-synthetic.qfx'));
  await env.drop('two.qfx', await fixture('card-synthetic.qfx'));
  const later = (await fixture('checking-synthetic.qfx')).toString().replaceAll('20260101', '20260106');
  await env.drop('later.qfx', later);
  const attempted: string[] = [];
  const accept = env.options.importRows;
  env.options.importRows = async (account, rows, statement) => {
    if (account === 'Synthetic Checking') {
      attempted.push(rows[0].postedDate);
      throw new Error('ambiguous sync with sensitive payload');
    }
    return accept(account, rows, statement);
  };
  assert.equal(await runInbox(env.options), false);
  assert.deepEqual(attempted, ['2026-01-01']);
  assert.deepEqual(await env.pending(), ['later.qfx', 'one.qfx']);
  let accounts = await loadAccounts(env.state, env.options.warn);
  assert.equal(accounts.has('checking'), false);
  assert.ok(accounts.get('card')?.latestPostedDate);
  assert.match(env.reports[0], /latest posted: none, next export from: 2025-06-01/);
  assert.ok(env.warnings.every(message => !message.includes('sensitive')));
  assert.equal(await runInbox({ ...env.options, importRows: accept }), true);
  accounts = await loadAccounts(env.state, env.options.warn);
  assert.equal(accounts.get('checking')?.latestPostedDate, '2026-01-06');
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
  const next = new Map([['checking', { identity: 'b'.repeat(64), lastRun: now.toISOString(), importedHashes: ['a'.repeat(64)] }]]);
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
  assert.match(env.reports.join('\n'), /checking: 1 files processed .*1 added.*next export from: 2025-12-29/);
  assert.match(env.reports.join('\n'), /card: 1 files processed .*2 added.*next export from:/);
  assert.deepEqual(await env.pending(), []);
});

test('an atomic second drop with the same basename stays separate from the claimed job', async t => {
  const env = await setup(t);
  const initial = await fixture('checking-synthetic.qfx');
  await env.drop('same.qfx', initial);
  const later = initial.toString().replaceAll('20260101', '20260106');
  const accept = env.options.importRows;
  env.options.importRows = async (account, rows, statement) => {
    await env.drop('same.qfx', later);
    return accept(account, rows, statement);
  };
  assert.equal(await runInbox(env.options), true);
  assert.equal(await readFile(join(env.inbox, 'same.qfx'), 'utf8'), later);
  const archive = join(env.dataRoot, 'archive/checking/2026');
  const [saved] = await readdir(archive);
  assert.deepEqual(await readFile(join(archive, saved)), initial);
  assert.equal(await runInbox({ ...env.options, importRows: accept }), true);
  assert.equal((await loadAccounts(env.state, env.options.warn)).get('checking')?.latestPostedDate, '2026-01-06');
});

test('does not reuse hashes or dates against a different budget', async t => {
  const env = await setup(t);
  await env.drop('original.qfx', await fixture('checking-synthetic.qfx'));
  assert.equal(await runInbox(env.options), true);
  await env.drop('repeat.qfx', await fixture('checking-synthetic.qfx'));
  await assert.rejects(runInbox({ ...env.options, budgetIdentity: 'different-budget' }), /destination changed/);
  assert.deepEqual(await readdir(env.inbox), ['.processing', 'repeat.qfx']);
  assert.equal(env.calls.length, 1);
});

test('retains routed files when the parser is unavailable and continues a healthy account', async t => {
  const env = await setup(t);
  const first = await fixture('checking-synthetic.qfx');
  await env.drop('first.qfx', first);
  await env.drop('later.qfx', first.toString().replaceAll('20260101', '20260106'));
  await env.drop('card.qfx', await fixture('card-synthetic.qfx'));
  const parse = env.options.parseRows!;
  env.options.parseRows = async (contents, extension) => {
    if (contents.equals(first)) throw new Error('synthetic parser outage');
    return parse(contents, extension);
  };
  assert.equal(await runInbox(env.options), false);
  assert.deepEqual(env.calls, ['Synthetic Card']);
  assert.deepEqual(await env.pending(), ['first.qfx', 'later.qfx']);
  assert.deepEqual(await env.reasons(), []);
});

test('a changed claimed file stays pending and stops that account', async t => {
  const env = await setup(t);
  const initial = await fixture('checking-synthetic.qfx');
  await env.drop('first.qfx', initial);
  await env.drop('later.qfx', initial.toString().replaceAll('20260101', '20260106'));
  await env.drop('card.qfx', await fixture('card-synthetic.qfx'));
  const parse = env.options.parseRows!;
  env.options.parseRows = async (bytes, extension) => {
    if (bytes.equals(initial)) {
      const processing = join(env.inbox, '.processing');
      for (const directory of await readdir(processing)) {
        if ((await readdir(join(processing, directory))).includes('first.qfx')) {
          await writeFile(join(processing, directory, 'first.qfx'), 'changed synthetic contents');
        }
      }
    }
    return parse(bytes, extension);
  };
  assert.equal(await runInbox(env.options), false);
  assert.deepEqual(env.calls, ['Synthetic Card']);
  assert.deepEqual(await env.pending(), ['first.qfx', 'later.qfx']);
});
