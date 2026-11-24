#!/bin/bash -p
set +x
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

case ${1-} in
    --dry-run) fail 'Drop-folder intake has no dry-run mode. See Chase statements in README.md for single-file validation.' ;;
esac
[[ $# == 0 ]] || fail 'Usage: import.sh (set BGFIN_REAL_ROOT).'
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
    all(.[]; type == "object" and (.last4 | type == "string" and test("^[0-9]{4}$"))))' \
    "$BGFIN_ACCOUNTS_FILE" >/dev/null 2>&1 || fail 'Set each last4 to four digits in a valid config/accounts.json.'
jq -e 'all(.[]; .actualAccount | type == "string" and test("\\S") and (startswith("REPLACE_WITH_") | not))' \
    "$BGFIN_ACCOUNTS_FILE" >/dev/null 2>&1 || fail 'Set each actualAccount in config/accounts.json before importing.'

find_server
[[ -n $server_id ]] || fail 'Run setup.sh to start the real Actual server.'
check_server_data
[[ $(inspect_server '{{.State.Running}}') == true ]] || fail 'Run setup.sh to start the real Actual server.'
[[ $(inspect_server '{{with index .NetworkSettings.Networks "bgfin-real_default"}}{{.NetworkID}}{{end}}') ]] ||
    fail 'The real Actual server must be on the real Docker network.'

run_container() (
    docker_env=()
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
        --entrypoint timeout "$job_image" -k 10s 10m node dist/src/inbox-cli.js --qfx-only
)

status=0
# Only the known numeric fields in the intake summary may leave this wrapper.
counts=$(run_container 2>&1 | LC_ALL=C awk '
    /^[A-Za-z0-9_-]+: [0-9]+ files processed \([0-9]+ duplicates\), [0-9]+ added, [0-9]+ updated, [0-9]+ skipped, latest posted: / {
        files += $2; duplicates += substr($5, 2); added += $7; updated += $9; skipped += $11
    }
    /^[A-Za-z0-9_-]+: account is stale\.$/ { stale++ }
    END { printf "files=%.0f duplicates=%.0f added=%.0f updated=%.0f skipped=%.0f stale=%.0f\n",
        files, duplicates, added, updated, skipped, stale }') || status=$?
printf '%s\n' "$counts"
if (( status != 0 )); then fail "Import failed (exit $status). Check the settings, Docker and intake permissions."; fi
