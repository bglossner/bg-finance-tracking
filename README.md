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

Each input is an array of objects with `postedDate` in `YYYY-MM-DD` format (years 1000–9999), signed integer `amountMinor`, stable `imported_id`, and an optional `payee`. Use the same IDs for the same source transactions across files. The original import command reads normalized JSON.

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

## Chase statements

On Windows, [install the Chase QFX userscript](userscripts/README.md) to download activity from the signed-in dashboard.

For private browser capture analysis, see the [Chase HAR skeleton guide](tools/HAR_SKELETON.md).

Copy `config/accounts.example.json` to `config/accounts.json` and set each alias's
`actualAccount` to a unique open Actual account name or its ID. `last4` matches a
QFX/OFX account suffix and `filename` is a case-sensitive glob for the basename.
A conflicting or ambiguous automatic match fails. `--account` selects a known
alias explicitly and must agree with any QFX/OFX account suffix. A statement
without an account ID requires an explicit alias.

```sh
docker build -t bgfin-job -f ops/docker/Dockerfile.job .
docker run --rm --entrypoint npm bgfin-job run test:container

docker compose -p bgfin --env-file ops/docker/.env -f ops/docker/compose.yaml run --rm -T --no-deps \
  --volume "$PWD/inbox:/input:ro" \
  --volume "$PWD/config/accounts.json:/app/config/accounts.json:ro" \
  job import --file /input/checking-download.qfx --dry-run
```

A dry run prints the row count and inclusive posted-date range without opening
a budget. For a live single-file import, remove `--dry-run` and supply the
connection settings, `BGFIN_DATA_DIR` and `BGFIN_HISTORY_CUTOFF` described below.
In Docker, bind the same intake directory used by the drop-folder importer and
pass its path in the container as `BGFIN_DATA_DIR`. Both commands share the
same account checkpoints. To rebase with a single file, use
`import --file PATH --set-starting-balance ALIAS`. Set `BGFIN_ACCOUNTS_FILE` to
use an alternate config path. Host `npm test` skips tests that load Actual's
native binding.

Chase checking and card exports supply signed amounts. Purchases and checking
debits stay negative, while payments into the card and checking credits stay
positive. QFX/OFX uses FITIDs and rejects missing, all-zero or repeated IDs.
CSV uses a hash of stable row fields and a one-based occurrence index for identical
rows. A changed description or other hashed field creates a new identity. If an
export contains only some of a day's indistinguishable rows, the importer cannot
tell which occurrences were exported. Keep full days in overlapping CSV export
windows. Keep CSV and QFX/OFX date ranges disjoint for each account because their
identifiers differ.

QFX/OFX balance checks use `LEDGERBAL` in the bank or card response. Chase deposit
balances keep their sign. Chase card debt can arrive with either sign, so the
importer uses negative cents for either. The scrubbed Chase card sample shows
a positive ledger amount, negative purchases and positive payments. The OFX
specification signs ledger balances by their effect on the user's net worth
and gives negative card debt as its example. A positive card ledger value is
treated as debt, including in cases where the source uses it to mean an
overpayment. [OFX Banking Specification, §3.2.9.2](https://financialdataexchange.org/wp-content/uploads/2025/12/OFX-Banking-Specification-v2.3.pdf)

## Drop-folder imports

Set `BGFIN_DATA_DIR` to a dedicated absolute path outside every checkout. The
parent must already exist and the root and its subdirectories must be owned by
the importer with mode `700`. Start from `config/accounts.example.json` and
use a different Actual account for each alias. Prefer Actual account IDs so a
renamed or recreated account cannot match a stale name. Keep alias names free of account
numbers and other private details because aliases appear in the summary.

1. Run the importer once to create the directories and print the first `next export from` date.
2. In Chase's Activity list, download QFX for each account from its printed date, inclusive. Drop or `scp` the finished file into `inbox/`. For an explicit route, create `inbox/<alias>/` with mode `700` and drop it there. When copying a file into the inbox, use a `.part` name and rename it after the copy completes.
3. Run the importer again. Read each account's summary for counts and the next export date, and check the balance result. Check `quarantine/` and its `.reason.txt` files for rejected inputs. Files that fail to sync stay in the inbox for retry.

The first successful import for an alias with no checkpoint sets its starting
balance if the file has a valid `LEDGERBAL`. Actual sums transactions dated
through `DTASOF` inclusively, using the calendar date written in the statement.
The importer sets the opening amount to the ledger balance minus all other
account activity through that date. It dates the opening transaction one day
before the earliest of the account's activity, the history cutoff and the
statement date. It reuses Actual's flagged opening transaction when present or
creates one named **Starting Balance** with a fixed imported ID scoped to the
account. Multiple candidates or an opening split or transfer require manual
resolution.

Later imports check the balance without resetting the opening amount. A
positive difference means Actual is higher than the signed Chase balance.
Mismatches still complete the import successfully. To reset an opening amount,
drop a fresh QFX or OFX and run `npm run import -- --set-starting-balance ALIAS`
or pass the same flag to `ops/real/import.sh` for real QFX intake. When several
files are ready for the selected alias, the reset uses the most recent ledger
date in that run. An identical drop still checks the balance and can be used to
retry an explicit reset. CSV and statements with missing or invalid
`LEDGERBAL` print a skip note. `AVAILBAL` is ignored.

On Amazon Linux 2, build the job image as in the Chase statements section and
run the command inside it. For the existing local Actual stack, use an ignored
private env file with the Actual connection variables (`ACTUAL_SERVER_URL`
should be `http://actual-server:5006` on the stack's Docker network):

```sh
export BGFIN_DATA_DIR=/absolute/path/to/private-import-data
export BGFIN_HISTORY_CUTOFF=2025-01-01
mkdir -m 700 "$BGFIN_DATA_DIR"
docker run --rm --network bgfin_default --entrypoint npm \
  --user "$(id -u):$(id -g)" --env-file /absolute/path/to/private-actual.env \
  --env BGFIN_DATA_DIR=/intake --env BGFIN_HISTORY_CUTOFF \
  --env BGFIN_ACCOUNTS_FILE=/config/accounts.json \
  --volume "$BGFIN_DATA_DIR:/intake" \
  --volume "$PWD/config/accounts.json:/config/accounts.json:ro" bgfin-job run import
```

On Linux with a compatible native SQLite binding and `flock` installed, run
`npm run build` then `npm run import` with the same variables. Reuse one intake
data root for a budget so concurrent invocations share the lock and account
history. If a saved alias changes to a different account or budget, use a new
data root. A saved reference by name cannot detect an account that is deleted
and recreated under the same name. The importer keeps the Actual cache in private `state/actual-cache/`.

| Variable | Purpose |
| --- | --- |
| `BGFIN_DATA_DIR` | Required private data root |
| `BGFIN_HISTORY_CUTOFF` | Required first export date, `YYYY-MM-DD` |
| `BGFIN_ACCOUNTS_FILE` | Account mapping, defaults to `config/accounts.json` |
| `BGFIN_MIN_FILE_AGE_SECONDS` | Minimum age after the file's last modification, defaults to `10` |
| `BGFIN_STALE_DAYS` | Warn if the latest imported posted date is older than this many UTC calendar days, defaults to `10` |
| `ACTUAL_SERVER_URL`, `ACTUAL_SERVER_PASSWORD`, `ACTUAL_BUDGET_SYNC_ID` | Actual connection and budget |
| `ACTUAL_E2E_PASSWORD` | Optional encrypted budget password |

`inbox/` holds complete input files and optional alias subdirectories. QFX,
OFX and CSV extensions are case-insensitive. Claimed jobs live in
`inbox/.processing/` until they are archived or quarantined. A sync error
keeps that job and later jobs for its account pending. Other accounts continue. `archive/<alias>/YYYY/` uses the
latest posted year in each file and marks exact duplicates in the archived
name. For an empty statement, it uses the current UTC year. `quarantine/`
holds rejected inputs and their reasons. `state/accounts.json` holds each
account's latest successful posted date, successful import time and file hashes.
It stores the last balance check's date and `ok` or `mismatch` status.
If the state file is corrupt, the importer keeps a copy in `state/` and uses the
configured cutoff until successful imports rebuild the checkpoints. Actual uses
transaction IDs to deduplicate overlapping exports and retries.

## Scheduling

The hourly job imports completed Chase drops, archives successful files, and
quarantines rejected files. An empty inbox or an overlapping scheduled run
exits successfully. Use the same wrapper for manual retries.

### Installation for glossner

Build `bgfin-job` as shown above and configure `config/accounts.json`.
The wrapper uses the local Docker socket and the existing `bgfin_default`
network by default. Set `BGFIN_DOCKER_NETWORK` in the env file for a separate
Docker network. `BGFIN_JOB_IMAGE` can select a different locally built job
image. `BGFIN_ACCOUNTS_FILE` can select a canonical external mapping file.
Create a mode `700` intake root and an owner-only mode `600` env
file outside the checkout. In the env file, use one literal `KEY=value` per
line, without shell quoting, `export`, or interpolation. Set
`ACTUAL_SERVER_URL=http://actual-server:5006`, `ACTUAL_SERVER_PASSWORD`,
`ACTUAL_BUDGET_SYNC_ID`, and `BGFIN_HISTORY_CUTOFF`. The optional settings
are `ACTUAL_E2E_PASSWORD`, `BGFIN_MIN_FILE_AGE_SECONDS`, and `BGFIN_STALE_DAYS`.
Use a canonical path for the data root and env file.

Copy both units and adjust `ExecStart` and the two `Environment` paths in
`bgfin-import.service` for the checkout and private files before activation.
The service uses `NoNewPrivileges` and `UMask`. Filesystem namespace hardening
such as `ProtectSystem` requires user namespace support for user services and
is omitted for compatibility with Amazon Linux 2.

```sh
mkdir -p ~/.config/systemd/user
cp ops/schedule/bgfin-import.{service,timer} ~/.config/systemd/user/
# Edit the copied service paths if needed, then activate the timer.
systemctl --user daemon-reload
systemctl --user enable --now bgfin-import.timer
systemctl --user list-timers bgfin-import.timer
systemctl --user status bgfin-import.timer bgfin-import.service
journalctl --user -u bgfin-import.service
```

For runs while glossner is logged out, glossner can opt in with
`loginctl enable-linger glossner`. The persistent timer catches a missed
calendar trigger when the user manager comes back. The cron alternative in
`ops/schedule/crontab.example` uses the same wrapper and lock. Standard cron
skips missed triggers. On return, run the wrapper once with the same paths to
catch up. Install a single scheduler.

Check `logs/import.log` under the intake root for UTC run timestamps and
aggregate counts. It rotates at 64 KiB and keeps one previous file. A nonzero
`stale` count means one or more accounts lack a successful posted date or are
older than `BGFIN_STALE_DAYS`. The manual intake command prints the affected
aliases and next export dates. A nonzero `failures` count marks a failed job.

To uninstall the timer, glossner runs:

```sh
systemctl --user disable --now bgfin-import.timer
rm ~/.config/systemd/user/bgfin-import.{service,timer}
systemctl --user daemon-reload
```

Remove the example entry instead when using cron. If linger was enabled solely
for this job, glossner can opt out with `loginctl disable-linger glossner`.

For bills, set recurring [Actual Budget schedules](https://actualbudget.org/docs/advanced/schedules/)
and add a calendar reminder before each due date. Keep automatic posting for
bills where it is wanted and test delivery with a calendar reminder.

## Real budget setup (glossner)

For setup on a Windows computer, follow the [Windows 11 and WSL 2 guide](WINDOWS_SETUP.md).

1. On the cloud desktop, run setup from the repository root. It requires
   Docker Compose v2.24.4 or later, `ss`, and `jq`.

   ```sh
   export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
   ops/real/setup.sh
   ```

   Use an absolute root outside Git checkouts and `/tmp`. The setup keeps
   existing private config files and uses `bgfin-job:real` for QFX-only intake.
   Port 5007 is the default. Set `BGFIN_REAL_PORT` before setup to use another
   port and substitute it in the SSH forward and browser URL.
2. On the laptop, run `ssh -L 127.0.0.1:5007:127.0.0.1:5007 <cloud desktop host>` and open
   [Actual Budget](http://localhost:5007).
3. Set the server password and create the budget.
4. Create the Chase checking and credit card accounts with zero opening balances.
   Their first QFX imports set the starting balances automatically when
   `LEDGERBAL` is present and valid.
5. Copy the budget Sync ID from **Settings > Advanced** and enter it and the
   server password in `$BGFIN_REAL_ROOT/config/actual.env`. Set
   `BGFIN_HISTORY_CUTOFF` to the first export date in `YYYY-MM-DD` format.
   Enter values literally after `=`, including any special characters. For
   an encrypted budget, also set `ACTUAL_E2E_PASSWORD`.
6. Fill in `last4` and `actualAccount` for both aliases in
   `$BGFIN_REAL_ROOT/config/accounts.json`. Use a different Actual account
   for each alias and prefer the ID from each account URL. Replace `XXXX` in
   each filename glob with that account's suffix to match Chase's QFX basenames.
7. In each Chase account's **Activity** page, download QFX starting at the
   history cutoff, inclusive. Drop the files into `$BGFIN_REAL_ROOT/intake/inbox/`.
   For `scp`, upload with a `.part` suffix and rename to `.qfx` when the copy
   finishes. Wait at least 10 seconds after the last write before importing.
8. The drop-folder importer has no `--dry-run`. To preview an individual QFX,
   substitute its basename and run the existing single-file command offline.

   ```sh
   file='replace-with-export-basename.qfx'
   docker --host unix:///var/run/docker.sock run --rm --pull never --network none --log-driver none \
     --user "$(id -u):$(id -g)" \
     --env BGFIN_ACCOUNTS_FILE=/config/accounts.json \
     --mount "type=bind,source=$BGFIN_REAL_ROOT/intake/inbox,target=/input,readonly" \
     --mount "type=bind,source=$BGFIN_REAL_ROOT/config/accounts.json,target=/config/accounts.json,readonly" \
     bgfin-job:real import --file "/input/$file" --dry-run
   ```

   When ready, run `ops/real/import.sh` on the cloud desktop.
   `ops/real/status.sh` reports the server and counts regular files in the
   inbox and quarantine, including quarantine reason files.
9. Look for `balance check: matches as of` for each account. A local interactive
   run shows the signed difference on a mismatch. Scheduled and redirected runs
   show the status and date. To correct an account with an existing checkpoint,
   rebuild the job image from the updated checkout, drop a fresh QFX for that
   account, then run the reset once for its alias.

   ```sh
   docker --host unix:///var/run/docker.sock build --tag bgfin-job:real -f ops/docker/Dockerfile.job .
   ops/real/import.sh --set-starting-balance chase-checking
   ```
10. Optionally copy the [scheduling units](ops/schedule) as
    `bgfin-real-import.service` and `bgfin-real-import.timer`. In the copied
    service, use `ExecStart=/bin/bash -p /absolute/checkout/ops/real/import.sh`
    and replace both existing `Environment` lines with
    `Environment=BGFIN_REAL_ROOT=%h/.local/share/bg-finance-tracking/real`.
    Run `systemctl --user daemon-reload` and then
    `systemctl --user enable --now bgfin-real-import.timer`. Read aggregate
    output with `journalctl --user -u bgfin-real-import.service`. If a run
    fails because another import holds the lock, let that import finish
    before retrying.

Keep the real directory, Actual browser session, and credentials out of agent
sessions. Owner-only modes still allow programs running as glossner to read
this data. Share only aggregate counts or redacted errors with agents. See
[teardown and backups](ops/real/teardown.md).
