import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { StartingBalanceError, importIntoActual, parseImportRows, readImportConfig } from './actual.js';
import { runSingleStatement } from './inbox.js';
import { quietActual, statementSettings } from './statement-config.js';

async function main() {
  let job;
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean' }, file: { type: 'string' }, account: { type: 'string' },
        'set-starting-balance': { type: 'string' },
      },
    });
    if (positionals[0] === 'import' && (positionals.length !== 2 || values.file !== undefined || values.account !== undefined)) {
      if (positionals.length !== 1 || !values.file) {
        throw new Error('Usage: cli.js import --file PATH [--account ALIAS] [--dry-run | --set-starting-balance ALIAS]');
      }
      const { chase, parseAccounts } = await import('./importers/chase.js');
      const config = await readFile(process.env.BGFIN_ACCOUNTS_FILE ?? 'config/accounts.json', 'utf8').catch(() => {
        throw new Error('Cannot read accounts configuration. Set BGFIN_ACCOUNTS_FILE or create config/accounts.json.');
      });
      const routes = parseAccounts(config);
      const setStartingBalance = values['set-starting-balance'];
      if (setStartingBalance !== undefined && (values['dry-run'] || (values.account !== undefined && values.account !== setStartingBalance))) {
        throw new Error('--set-starting-balance requires a live import for the same alias as --account.');
      }
      const statement = await quietActual(() => chase.parse(values.file!, { routes, alias: values.account ?? setStartingBalance }));
      const { rows } = statement;
      if (values['dry-run']) {
        const dates = rows.map(row => row.postedDate).sort();
        console.log(JSON.stringify({ validated: rows.length, from: dates[0] ?? null, through: dates.at(-1) ?? null }));
        return;
      }
      const options = await statementSettings(process.env, routes);
      if (setStartingBalance !== undefined && !statement.balance) throw new Error('Supply a statement with valid LEDGERBAL for the selected alias.');
      const warn = console.error.bind(console);
      try {
        const { added, updated } = await quietActual(() => runSingleStatement({
          ...options, report: warn, warn, setStartingBalance, showBalanceDifference: process.stderr.isTTY,
        }, statement));
        console.log(JSON.stringify({ added, updated }));
      } catch (error) {
        console.error(error instanceof StartingBalanceError ? error.message :
          'Actual import failed. Check the server, budget configuration and account mapping.');
        process.exitCode = 1;
      }
      return;
    } else {
      if (values.file !== undefined || values.account !== undefined) throw new Error('Use --file and --account with the import command.');
      if (values['set-starting-balance'] !== undefined) throw new Error('Use --set-starting-balance with the statement import command.');
      if (positionals.length === 0 && values['dry-run']) {
        console.log('Usage: cli.js [--dry-run] ACCOUNT_ALIAS TRANSACTIONS.json');
        return;
      }
      if (positionals.length !== 2) throw new Error('Usage: cli.js [--dry-run] ACCOUNT_ALIAS TRANSACTIONS.json');
      const [alias, path] = positionals;
      const contents = await readFile(path, 'utf8').catch(() => {
        throw new Error('Cannot read transaction file.');
      });
      const rows = parseImportRows(contents);
      if (values['dry-run']) {
        console.log(JSON.stringify({ validated: rows.length }));
        return;
      }
      job = { rows, config: readImportConfig(process.env, alias) };
    }
  } catch (error) {
    console.error(error instanceof Error && !('code' in error) ? error.message : 'Invalid import input.');
    process.exitCode = 2;
    return;
  }

  // Actual can log transaction fields from an invalid budget rule even in quiet mode.
  const { error, warn } = console;
  console.error = console.warn = () => {};
  let result;
  try {
    const api = await import('@actual-app/api');
    result = await importIntoActual(api, job.config, job.rows);
  } catch {
    process.exitCode = 1;
  } finally {
    console.error = error;
    console.warn = warn;
  }
  if (result) console.log(JSON.stringify(result));
  else console.error('Actual import failed. Check the server, budget configuration and account mapping.');
}

process.umask(0o077);
await main();
