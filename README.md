# Finance tracking

A TypeScript importer for normalized transactions from downloaded statements.

Use Node.js 26.12.1 from `.nvmrc` and its bundled npm. On Linux, install Python 3.10+, `make`, and a C++20 toolchain for the API dependency’s native SQLite binding.
On Amazon Linux 2 cloud desktops, run commands through mise, for example `mise exec node@26.12.1 -- npm ci`.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

On Amazon Linux 2, run budget operations inside the job container. The Actual API’s native SQLite binding requires a newer glibc than the host provides.

## Local Actual stack

From the repository root, create an owner-only directory outside the checkout and create the ignored `ops/docker/.env` from `ops/docker/.env.example`. Set `BGFIN_ACTUAL_DATA_DIR` to that directory’s absolute path. Keep the env file mode 600.

```sh
docker compose -p bgfin --env-file ops/docker/.env -f ops/docker/compose.yaml up -d --wait actual-server
docker compose -p bgfin --env-file ops/docker/.env -f ops/docker/compose.yaml build job
```

Open [Actual Budget](http://127.0.0.1:5006), set the server password, and create a budget and account. Put the server password, budget Sync ID (under advanced settings), and alias-to-account-ID JSON mapping in the ignored env file. Find the account ID in the URL after opening the account in Actual. Set `ACTUAL_E2E_PASSWORD` for an encrypted budget. Compose supplies the server URL on its own network. Use only synthetic data in the throwaway instance.

Each input is an array of objects with `postedDate` in `YYYY-MM-DD` format (years 1000–9999), signed integer `amountMinor`, stable `imported_id`, and an optional `payee`. Use the same IDs for the same source transactions across files. This CLI reads normalized JSON. Statement format adapters are future work.

```sh
node dist/src/cli.js --dry-run chase-checking test/fixtures/synthetic-chase-checking.json
docker compose -p bgfin --env-file ops/docker/.env -f ops/docker/compose.yaml run --rm -T \
  --volume "$PWD/test/fixtures:/input:ro" job \
  chase-checking /input/synthetic-chase-checking.json
```

Repeat the fixture command against a freshly seeded synthetic budget to verify zero new rows on the second run. Then use `synthetic-chase-checking-overlap.json` to add exactly two more.

Compose allows one import at a time because jobs share an Actual API cache. The CLI prints added and updated counts after syncing. Replays use the original source IDs.

```sh
docker compose -p bgfin --env-file ops/docker/.env -f ops/docker/compose.yaml down
```

The server files stay in `BGFIN_ACTUAL_DATA_DIR` and the API cache stays in the `bgfin_actual-cache` volume. For an intentional throwaway reset, use `down --volumes` and delete the external directory after checking its path.

Each account will track its latest successfully imported posted date. The next export starts three calendar days before that date, inclusive. A first export starts at the chosen history cutoff. Imports deduplicate overlapping rows by `imported_id` within each account.

Never commit real financial data or credentials. Keep exports, local account mappings, runtime state, and Actual Budget caches out of Git. Keep CAMT exports with an `.xml` extension in the ignored import directories. Use only synthetic data in `test/fixtures/`.
