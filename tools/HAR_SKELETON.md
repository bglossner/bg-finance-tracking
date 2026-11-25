# Chase HAR skeleton

The HAR skeleton describes the requests involved in downloading a QFX file. Work with glossner's own capture locally. Share only reviewed output from the tool.

## Capture one download

1. Prefer a fresh browser profile with no unrelated tabs or extensions. Sign in to Chase and open one account's **Activity** page.
2. Open the developer tools **Network** panel. Disable **Preserve log**, pause recording, and clear the request list. Set the export range and format before recording if the page allows it.
3. Start recording just before clicking **Download** for QFX. Stop as soon as the download finishes. Export the captured requests as a HAR, using the browser's sanitized export option if available. The HAR can still contain account data and transaction bodies. Save it in a private local folder outside Git and cloud sync.

## Run locally

Run from the repository root. `python3 --version` must show Python 3.10 or newer. On Windows, check the interpreter selected by `py -3 --version`. Substitute paths to a private local folder for both the capture and output.

WSL, using a directory on the WSL Linux filesystem for owner-only mode `600`:

```sh
python3 -I tools/har_skeleton.py ~/private/chase-download.har -o ~/private/chase-skeleton.json
```

Windows PowerShell, using an NTFS folder that only glossner's account can access:

```powershell
py -3 -I tools\har_skeleton.py "$env:LOCALAPPDATA\Private\chase-download.har" -o "$env:LOCALAPPDATA\Private\chase-skeleton.json"
```

Check the destination folder's Windows permissions. Native Windows uses inherited NTFS access control. POSIX mode `600` applies on filesystems that enforce POSIX permissions. `-o` avoids terminal scrollback and enables exclusive creation. Use `--force` to replace a previous skeleton. Without `-o`, the command prints checked JSON to stdout. `--include-host-pattern REGEX` uses a full match against the normalized hostname to retain an additional host.

Run the synthetic tests from the repository root:

```sh
python3 -I -B -m unittest discover -s tests/python -v
```

## What the skeleton contains

- Zero-based entry indexes, whole seconds relative to the first entry, bucketed total durations, standard HTTP methods, origins, and path-template counts. Origins keep the scheme and hostname for `chase.com`, `jpmorgan.com`, `jpmorganchase.com`, `jpmchase.com`, and their subdomains. Other hosts collapse to `<third-party>` by default. Paths keep short ASCII letter-only segments and one- or two-digit versions such as `v1`. Identifiers and other segments become placeholders.
- Sorted query names with value-type hints, request and response header names, and counts in place of `Cookie` and `Set-Cookie`. The URL query takes precedence over the HAR's duplicate query list. Safe MIME tokens can appear for the request and response. MIME parameters are removed. `Accept` is kept only when it is a single valid token or `*/*`.
- Request JSON and form field shapes, multipart field names, and a MIME and size hint for other request bodies. Responses retain status, MIME and size bucket, and a short filename extension if available. JSON arrays show the first element's shape and a count bucket. QFX, OFX, and XML bodies expose ordered unique opening tag names. Other response bodies are omitted.

The output drops literal query and body values, cookie names and values, authentication values, filenames, absolute timestamps, IP and connection metadata, detailed timings, page titles, comments, and private HAR metadata. It also drops JSON body keys that start with `_`. The tool recognizes plain and base64-encoded HAR response bodies for supported formats when the export includes them.

## What the self-check verifies

Before writing, the tool checks retained strings, including header names, parameter names, JSON keys and OFX tags, for copies of collected input values. It collects header values, cookie names and values, query and form values, complete query strings, JSON scalar values, body text tokens, and URL path segments replaced by placeholders. It checks copies of eight or more characters, digit runs of four or more digits, and shorter credential parts in retained names and other structural fields.

The check also looks for email addresses, dates, amounts, JWTs and token-like base64. It recognizes generated hints and buckets, conventional names, and protocol declarations. It exempts each recognized occurrence separately. Examples include media declarations, CORS lists made of retained header names, and exact bank origins in Chrome initiator URL fields. HTTP/2 `:path` and `Referer` still contribute query values and sensitive path segments. A copy from an independent data field still triggers refusal. A refusal writes no skeleton and reports only field positions.

## Diagnose a refusal

WSL:

```sh
python3 -I tools/har_skeleton.py --diagnose "$HOME/private/chase-download.har" > har-diagnose.txt
```

Windows PowerShell:

```powershell
py -3 -I tools\har_skeleton.py --diagnose "$env:LOCALAPPDATA\Private\chase-download.har" > har-diagnose.txt
```

`--diagnose` always exits nonzero. It writes a JSON report to stdout, including on a clean run, and accepts neither `-o` nor `--force`. The report gives the tool and Python versions, entry count, and count of distinct offender paths. Each bucket counts paths by rule and field kind. Copied-value buckets also count paths by the kind of input source that matched. One path can count toward several rules or source kinds. Each bucket includes up to five field positions and descriptions using only length ranges and character classes. A `processing-failed` report uses `null` for an unavailable count.

Skim `har-diagnose.txt` before sharing. The report uses fixed labels, numeric counts, and field positions. Keep the HAR local.

## Review and delete

If the self-check reports offenders, share only the reviewed diagnostic report or the printed field paths, such as `$.entries[0].response.headers[3]`. Keep the HAR and private values local. Legitimate names can still resemble secrets to the check.

Open the output locally in a text editor before sharing. Look at every origin, path, name, MIME token, and filename extension. Check for session and device identifiers, names, email addresses, account numbers or suffixes, balances, transactions, and other private data. Short strings, tokens that look like ordinary names, and information encoded in counts or request ordering can escape the checks. A successful run leaves the source HAR sensitive.

After reviewing the skeleton, delete the HAR and any extra copies from export folders and the Recycle Bin or Trash. Also delete the QFX downloaded during recording if it is no longer needed. Use private, encrypted local storage from the start. Deleting a file may leave recoverable copies on SSDs, snapshots, synced folders, or backups. Remove those copies where possible.

The intended next step is a Tampermonkey userscript running in glossner's own logged-in Chase browser session. Avoid storing Chase cookies for Python replay.
