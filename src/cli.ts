import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { importIntoActual, parseImportRows, readImportConfig } from './actual.js';

async function main() {
  let job;
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { 'dry-run': { type: 'boolean' } },
    });
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid import input.');
    process.exitCode = 2;
    return;
  }

  try {
    const api = await import('@actual-app/api');
    console.log(JSON.stringify(await importIntoActual(api, job.config, job.rows)));
  } catch {
    console.error('Actual import failed. Check the server, budget configuration and account mapping.');
    process.exitCode = 1;
  }
}

await main();
