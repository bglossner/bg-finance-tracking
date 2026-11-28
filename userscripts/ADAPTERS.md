# Bank userscript adapters

Each bank has one installable `.user.js` scoped to that bank's dashboard. `npm run build:userscripts` uses Node's standard library to concatenate the adapter's Tampermonkey header, [the shared core](core.js), and the adapter body inside one private scope. Commit the generated `.user.js` alongside its sources. Glossner can install it directly in Tampermonkey. The userscript tests check that regeneration yields the same bytes.

The Chase script is version `1.1.0`. Its name, implicit namespace (the existing header omits `@namespace`), and exact dashboard match are preserved. A manual installation can be updated by replacing the source in the existing Tampermonkey editor entry and saving. The new version reads the existing dates on the same Chase origin.

## Adapter interface

| Field or hook | Contract |
| --- | --- |
| `id`, `label` | Stable lowercase storage namespace and public bank display name. |
| `origins`, `@match` | Exact HTTPS origins at runtime and narrow HTTPS dashboard matches in the metadata. Use `@grant none` and `@noframes`. Leave `@connect` and `@require` absent. |
| `isReadyPage(location)` | Return whether the signed-in export page is ready. The core also checks the exact origin and top-level window. |
| `listAccounts(ctx)` | Return `{ key, id, family, last4, label }` per eligible account. Use a stable, non-identifying `key` unique to the account within the bank. Where the bank supplies only a stable ID, use `hashAccountKey(id, salt)` with a fixed adapter-specific salt. Keep identifiers in memory and use masked labels drawn from known account types. |
| `getSessionToken(ctx, account)` | Optional. Obtain any required token for each attempt. Recheck account eligibility when the bank needs fresh account data. Keep tokens in memory. |
| `buildDownloadRequest(account, from, to, token)` | Return `{ path, method, headers, body? }`. The dates are inclusive `YYYY-MM-DD` values. Apply the bank's serialization and use its observed same-origin endpoint. |
| `formats` | Array of supported formats such as `["QFX"]` or `["CSV"]`. The first entry names the format used by the panel and this adapter's download hooks. |
| `validateResponse(text, account, from, to)` | Return `{ ok: true }` or `{ ok: false, reason, code? }`. Supported reasons include `no-statement`, `no-transactions`, `wrong-family`, `wrong-account`, `multiple-statements`, `not-ofx`, and `status-error` with a numeric `code`. Other validation failures get the generic invalid-format message. QFX adapters can reuse `validateOfx(text, family, last4, from, to)` for supported deposit and card statements. |
| `filename(account, from, to)` | Return the download name that matches the appropriate `accounts.json` glob. Use only masked routing fields and the date range. |
| `delayMs`, `retryOnRequestFailure` | Optional. The core waits 700 ms between queued requests and retries a failed request once by default. Set `retryOnRequestFailure: false` to skip retries. A validation result ends the attempt. |
| `emptyAccountsMessage` | Optional static message for an empty eligible account list. |
| `legacyDatePrefix` | Optional previous storage prefix used to migrate existing dates and retain the existing cross-tab download lock during an upgrade. The account key must be the same suffix the old script used. |

Use `ctx.request(spec)` for account lookup and token requests. It returns a Fetch `Response` and applies same-origin credentials, a timeout, cache bypass, and redirect rejection. `ctx.signal` is the abort signal for the current page visit. Keep raw request URLs, headers, account IDs, export content, and exceptions out of status messages and diagnostics.

The core owns the panel, Refresh, the download queue and lock, abort handling, validation messages, and the local Blob download. It treats labels and messages as text. Confirmed dates are stored under `bgfin.userscript.<id>.v1.date.<key>`. Chase retains the same SHA-256 key suffix it used under `bgfin.chase-qfx.v1.*`. Opening a row copies a valid newer legacy date into the new key when possible and preserves the old key. To see fixed diagnostic messages in the panel, set the origin-local `bgfin.userscript.<id>.v1.debug` flag to `1` and select Refresh. Remove the flag and Refresh to turn diagnostics off.

## Add a bank

1. In `import-docs/<bank>/`, record the signed-in dashboard origin and route, plus the account-list request and a scrubbed response with the fields for eligibility, type, masked suffix, and stable ID. Use synthetic IDs consistently across the samples.
2. Record the observed download request for each account type. Include the method, origin and path, parameter and body formats, relevant headers, export type, and where a fresh session token comes from. Use placeholders for tokens and remove cookies, authorization headers, and browser identifiers before sharing.
3. Save one scrubbed export per account type. Preserve the format, field names and relevant date and account shapes. Replace account and transaction identifiers, names, amounts, balances and other personal values with synthetic data. Review every file before committing it to the public repository.
4. Record the filename pattern and the importer `accounts.json` glob that should route it. If the exporter adds a format the importer cannot read, such as a new CSV layout, add the reader through separate importer work.
5. Copy [the adapter template](adapters/_template.js), implement it from the samples, and add its source and output name to [the generator](build.mjs). Add fixture checks for requests, validation and filename routing. Generate and commit the installed script, run `node --check` on it, and run `node --test test/userscript/*.test.js`.
