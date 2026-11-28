import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runInbox } from './inbox.js';
import { parseAccounts } from './importers/chase.js';
import { quietActual, statementSettings } from './statement-config.js';

function integerSetting(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Set ${key} to a nonnegative integer.`);
  return Number(value);
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { 'qfx-only': { type: 'boolean' }, 'set-starting-balance': { type: 'string' } } }));
  } catch {
    throw new Error('Usage: inbox-cli.js [--qfx-only] [--set-starting-balance ALIAS]');
  }
  const contents = await readFile(process.env.BGFIN_ACCOUNTS_FILE ?? 'config/accounts.json', 'utf8').catch(() => {
    throw new Error('Cannot read accounts configuration. Set BGFIN_ACCOUNTS_FILE or create config/accounts.json.');
  });
  const options = await statementSettings(process.env, parseAccounts(contents));
  const report = console.log.bind(console);
  const warn = console.error.bind(console);
  const complete = await quietActual(() => runInbox({
    ...options, report, warn, setStartingBalance: values['set-starting-balance'],
    showBalanceDifference: process.stdout.isTTY,
    acceptedExtensions: values['qfx-only'] ? ['.qfx'] : undefined,
    minimumAgeSeconds: integerSetting('BGFIN_MIN_FILE_AGE_SECONDS', 10),
    staleDays: integerSetting('BGFIN_STALE_DAYS', 10),
  }));
  if (!complete) process.exitCode = 1;
}

process.umask(0o077);
try {
  await main();
} catch (error) {
  console.error(error instanceof Error && !('code' in error) ? error.message : 'Inbox intake could not start. Check configuration and permissions.');
  process.exitCode = 1;
}
