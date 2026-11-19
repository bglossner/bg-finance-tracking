# Finance tracking

A TypeScript scaffold for importing downloaded account statements into Actual Budget.

Use Node.js 26.13.1 from `.nvmrc` and its bundled npm. On Linux, install Python 3.10+, `make`, and a C++20 toolchain for the API dependency’s native SQLite binding.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Run the one-shot CLI stub with `node dist/src/cli.js --dry-run`. Statement parsing, imports, and scheduling are future work.

Each account will track its latest successfully imported posted date. The next export starts three calendar days before that date, inclusive. A first export starts at the chosen history cutoff. Future imports will deduplicate overlapping rows by `imported_id` within each account.

Never commit real financial data or credentials. Keep exports, local account mappings, runtime state, and Actual Budget caches out of Git. Keep CAMT exports with an `.xml` extension in the ignored import directories. Use only synthetic data in `test/fixtures/`.
