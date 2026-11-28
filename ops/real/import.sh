#!/bin/bash -p
set +x
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

case ${1-} in
    --dry-run) fail 'Drop-folder intake has no dry-run mode. See Real budget setup in README.md for single-file validation.' ;;
esac
if (( $# )); then
    [[ $# == 2 && $1 == --set-starting-balance && $2 =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] ||
        fail 'Usage: import.sh [--set-starting-balance ALIAS] (set BGFIN_REAL_ROOT).'
fi
validate_real_root
BGFIN_DATA_DIR=$real_root/intake
BGFIN_ENV_FILE=$real_root/config/actual.env
BGFIN_ACCOUNTS_FILE=$real_root/config/accounts.json
private_dir "$real_root"
private_dir "$real_root/config"
private_dir "$BGFIN_DATA_DIR"
private_file "$BGFIN_ENV_FILE"
private_file "$BGFIN_ACCOUNTS_FILE"

# Read literal settings once. Only these keys can reach Docker or the importer.
declare -A settings=()
while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    case "$line" in ''|\#*) continue ;; esac
    [[ $line == *=* ]] || fail 'Expected literal KEY=value lines in config/actual.env.'
    key=${line%%=*}
    case "$key" in
        ACTUAL_SERVER_URL|BGFIN_DOCKER_NETWORK|ACTUAL_SERVER_PASSWORD|ACTUAL_BUDGET_SYNC_ID|ACTUAL_E2E_PASSWORD|BGFIN_HISTORY_CUTOFF|BGFIN_MIN_FILE_AGE_SECONDS|BGFIN_STALE_DAYS) ;;
        *) fail 'Unexpected setting in config/actual.env.' ;;
    esac
    [[ ! ${settings[$key]+set} ]] || fail 'Duplicate setting in config/actual.env.'
    settings[$key]=${line#*=}
done < "$BGFIN_ENV_FILE"

for key in ACTUAL_SERVER_PASSWORD ACTUAL_BUDGET_SYNC_ID; do
    value=${settings[$key]-}
    [[ $value == *[![:space:]]* ]] || fail "Set $key in config/actual.env before importing."
done
[[ ${settings[ACTUAL_SERVER_URL]-} == http://actual-server:5006 && ${settings[BGFIN_DOCKER_NETWORK]-} == "$network" ]] ||
    fail 'config/actual.env must point to the real Actual server and Docker network.'
jq -es 'length == 1 and (.[0] | type == "object" and length > 0 and
    all(.[]; type == "object" and (.last4 | type == "string" and length == 4 and test("^[0-9]{4}$"))))' \
    "$BGFIN_ACCOUNTS_FILE" >/dev/null 2>&1 || fail 'Set each last4 to four digits in a valid config/accounts.json.'
jq -e 'all(.[]; .actualAccount | type == "string" and test("\\S") and (startswith("REPLACE_WITH_") | not))' \
    "$BGFIN_ACCOUNTS_FILE" >/dev/null 2>&1 || fail 'Set each actualAccount in config/accounts.json before importing.'
jq -e '[.[].actualAccount] | length == (unique | length)' "$BGFIN_ACCOUNTS_FILE" >/dev/null 2>&1 ||
    fail 'Use a different actualAccount for each alias in config/accounts.json.'
if (( $# )); then
    jq -e --arg alias "$2" 'has($alias)' "$BGFIN_ACCOUNTS_FILE" >/dev/null ||
        fail 'Unknown account alias for --set-starting-balance.'
fi

find_server
[[ -n $server_id ]] || fail 'Run setup.sh to start the real Actual server.'
check_server_data
[[ $(inspect_server '{{.State.Running}}') == true ]] || fail 'Run setup.sh to start the real Actual server.'
[[ $(inspect_server '{{with index .NetworkSettings.Networks "bgfin-real_default"}}{{.NetworkID}}{{end}}') ]] ||
    fail 'The real Actual server must be on the real Docker network.'

run_container() (
    docker_env=()
    if [[ $local_balances == 1 ]]; then docker_env+=(--tty); fi
    for key in "${!settings[@]}"; do
        [[ $key != BGFIN_DOCKER_NETWORK ]] || continue
        export "$key=${settings[$key]}"
        docker_env+=(--env "$key")
    done
    exec timeout -k 10s 12m "${local_docker[@]}" run --rm --pull never --log-driver none \
        --network "$network" --user "$EUID:$(id -g)" "${docker_env[@]}" \
        --env BGFIN_DATA_DIR=/intake --env BGFIN_ACCOUNTS_FILE=/config/accounts.json \
        --mount "type=bind,source=$BGFIN_DATA_DIR,target=/intake" \
        --mount "type=bind,source=$BGFIN_ACCOUNTS_FILE,target=/config/accounts.json,readonly" \
        --entrypoint timeout "$job_image" -k 10s 10m node dist/src/inbox-cli.js --qfx-only "$@"
)

status=0
# Signed differences are for an interactive local terminal. Redirected and
# scheduled runs retain the alias, status and date without the amount.
local_balances=0
if [[ -t 1 ]]; then local_balances=1; fi
output=$(run_container "$@" 2>&1 | LC_ALL=C awk -v local_balances="$local_balances" '
    { sub(/\r$/, "") }
    /^[A-Za-z0-9_-]+: [0-9]+ files processed \([0-9]+ duplicates\), [0-9]+ added, [0-9]+ updated, [0-9]+ skipped, latest posted: / {
        files += $2; duplicates += substr($5, 2); added += $7; updated += $9; skipped += $11
    }
    /^[A-Za-z0-9_-]+: account is stale\.$/ { stale++ }
    /^[A-Za-z0-9_-]+: balance check: off by [+-][0-9]+\.[0-9][0-9] as of [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ {
        if (local_balances) print
        else print $1, "balance check: mismatch as of", $9
    }
    /^[A-Za-z0-9_-]+: balance check: (matches|mismatch) as of [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ ||
    /^[A-Za-z0-9_-]+: balance check: skipped \(no valid LEDGERBAL\)\.$/ ||
    /^[A-Za-z0-9_-]+: Starting balance is ambiguous\. Keep one standalone opening transaction before retrying\.$/ ||
    /^[A-Za-z0-9_-]+: Actual supports opening dates from 1995-01-01 onward\.$/ ||
    /^[A-Za-z0-9_-]+: starting balance was not set\. Drop a completed QFX or OFX with valid LEDGERBAL and retry\.$/ { print }
    /^[A-Za-z0-9_-]+: to rebase, use --set-starting-balance [A-Za-z0-9_-]+ with a fresh QFX or OFX\.$/ {
        if ($1 == $6 ":") print $1, "to rebase, use --set-starting-balance", $6, "with a fresh QFX."
    }
    END { printf "files=%.0f duplicates=%.0f added=%.0f updated=%.0f skipped=%.0f stale=%.0f\n",
        files, duplicates, added, updated, skipped, stale }') || status=$?
printf '%s\n' "$output"
if (( status != 0 )); then fail "Import failed (exit $status). Check the settings, Docker and intake permissions."; fi
