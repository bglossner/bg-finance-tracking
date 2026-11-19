import { parseArgs } from 'node:util';

try {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' } } });
  console.log(values['dry-run'] ? 'Dry run selected. Import is pending.' : 'Import is pending.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
