#!/bin/bash -p
set -euo pipefail
export PATH=/usr/bin:/bin LC_ALL=C
umask 077

fail() { printf 'Scheduled import: %s\n' "$1" >&2; exit 1; }

# Start Docker and the parser with only the settings explicitly selected here.
if [[ ${1-} != --clean || $# != 1 ]]; then
    exec /usr/bin/env -i PATH="$PATH" LC_ALL=C \
        BGFIN_DATA_DIR="${BGFIN_DATA_DIR-}" BGFIN_ENV_FILE="${BGFIN_ENV_FILE-}" \
        /bin/bash -p "$0" --clean
fi
# The internal argument alone must never allow a caller to bypass isolation.
while IFS= read -r name; do
    case "$name" in
        PATH|LC_ALL|BGFIN_DATA_DIR|BGFIN_ENV_FILE|PWD|SHLVL|_) ;;
        *) unset "$name" ;;
    esac
done < <(compgen -e)

script=$(realpath -e -- "$0")
repo=${script%/ops/schedule/run-import.sh}
# Protect all registered checkouts, including the main checkout of a linked tree.
worktrees=$(git -C "$repo" worktree list --porcelain)
external_path() {
    local path=$1 root
    [[ $path == /* && $path != / && $path != *:* && $path != *$'\n'* ]] || return 1
    [[ $(realpath -e -- "$path") == "$path" ]] || return 1
    while IFS= read -r root; do
        [[ $root == worktree\ * ]] || continue
        root=${root#worktree }
        [[ $path != "$root" && $path != "$root/"* ]] || return 1
    done <<< "$worktrees"
    return 0
}

[[ -n $BGFIN_DATA_DIR ]] || fail 'Set BGFIN_DATA_DIR.'
external_path "$BGFIN_DATA_DIR" || fail 'Use a canonical data directory outside the checkout.'
[[ -d $BGFIN_DATA_DIR && $(stat -c '%u:%a' -- "$BGFIN_DATA_DIR") == "$EUID:700" ]] || fail 'Use an owner-only data directory (0700).'
external_path "$BGFIN_ENV_FILE" || fail 'Set BGFIN_ENV_FILE to a canonical path outside the checkout.'
[[ -f $BGFIN_ENV_FILE ]] || fail 'The environment file must be a regular file.'
exec 7< "$BGFIN_ENV_FILE"
mode=$(stat -Lc '%u:%a:%h' /proc/self/fd/7)
case "$mode" in "$EUID:600:1"|"$EUID:400:1") ;; *) fail 'Use a private owner-only environment file (0600 or 0400).' ;; esac

docker_network=bgfin_default
job_image=bgfin-job
accounts_file=$repo/config/accounts.json
docker_env=()
while IFS= read -r line || [[ -n $line ]]; do
    case "$line" in ''|\#*) continue ;; esac
    key=${line%%=*}
    [[ $line == *=* ]] || fail 'Expected KEY=value in environment file.'
    case "$key" in
        BGFIN_DOCKER_NETWORK)
            docker_network=${line#*=}
            [[ $docker_network =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && $docker_network != host ]] || fail 'Invalid Docker network.'
            continue ;;
        BGFIN_JOB_IMAGE)
            job_image=${line#*=}
            [[ $job_image =~ ^[A-Za-z0-9][A-Za-z0-9_./:@-]*$ ]] || fail 'Invalid Docker image.'
            continue ;;
        BGFIN_ACCOUNTS_FILE)
            accounts_file=${line#*=}
            external_path "$accounts_file" || fail 'Use a canonical external accounts file.'
            continue ;;
        ACTUAL_SERVER_URL|ACTUAL_SERVER_PASSWORD|ACTUAL_BUDGET_SYNC_ID|ACTUAL_E2E_PASSWORD|BGFIN_HISTORY_CUTOFF|BGFIN_MIN_FILE_AGE_SECONDS|BGFIN_STALE_DAYS) ;;
        *) fail 'Unexpected setting in environment file.' ;;
    esac
    export "$line"
    docker_env+=(--env "$key")
done <&7
exec 7<&-

logs=$BGFIN_DATA_DIR/logs
mkdir -p -- "$logs"
[[ ! -L $logs && $(stat -c '%u:%a' -- "$logs") == "$EUID:700" ]] || fail 'Use an owner-only logs directory (0700).'
write_log() (
    # Serialize rotation and appends, including runs that skipped the import lock.
    exec 8< "$logs"
    flock -w 5 8
    local log=$logs/import.log
    if [[ -e $log || -L $log ]]; then
        [[ -f $log && ! -L $log && $(stat -c '%u:%a:%h' -- "$log") == "$EUID:600:1" ]] || fail 'Invalid import log.'
        if (( $(stat -c %s -- "$log") >= 65536 )); then
            mv -fT -- "$log" "$log.1"
        fi
    fi
    printf '%s files=%s duplicates=%s added=%s updated=%s skipped=%s stale=%s busy=%s failures=%s\n' \
        "$(date -u +%FT%TZ)" "$@" >> "$log"
)

lock=$BGFIN_DATA_DIR/scheduled-import.lock
# Noclobber keeps concurrent creation safe and rejects a dangling symlink.
(set -o noclobber; : > "$lock") 2>/dev/null || :
[[ -f $lock && ! -L $lock && $(stat -c '%u:%a:%h' -- "$lock") == "$EUID:600:1" ]] || fail 'Invalid schedule lockfile.'
exec 9< "$lock"
if flock -n -E 75 9; then
    :
else
    status=$?
    [[ $status == 75 ]] || fail 'Could not acquire schedule lock.'
    write_log 0 0 0 0 0 0 1 0
    exit 0
fi

# A missing bind source is a job failure. Never let Docker create it.
if [[ ! -f $accounts_file || $accounts_file == *:* ]]; then
    write_log 0 0 0 0 0 0 0 1
    fail 'Expected an accounts mapping file.'
fi

# Only the documented intake summary and stale warning contribute to the log.
# Keep Docker and importer diagnostics out of persistent logs and the journal.
status=0
counts=$(timeout -k 10s 12m docker --host unix:///var/run/docker.sock run --rm --pull never \
    --log-driver none --network "$docker_network" --user "$EUID:$(id -g)" "${docker_env[@]}" \
    --env BGFIN_DATA_DIR=/intake --env BGFIN_ACCOUNTS_FILE=/config/accounts.json \
    --volume "$BGFIN_DATA_DIR:/intake" \
    --volume "$accounts_file:/config/accounts.json:ro" \
    --entrypoint timeout "$job_image" -k 10s 10m node dist/src/inbox-cli.js 9<&- 2>&1 |
    awk '/^[A-Za-z0-9_-]+: [0-9]+ files processed \([0-9]+ duplicates\), [0-9]+ added, [0-9]+ updated, [0-9]+ skipped, latest posted: / {
        files += $2; duplicates += substr($5, 2); added += $7; updated += $9; skipped += $11
    }
    /^[A-Za-z0-9_-]+: account is stale\.$/ { stale++ }
    END { printf "%.0f %.0f %.0f %.0f %.0f %.0f\n", files, duplicates, added, updated, skipped, stale }') || status=$?
read -r files duplicates added updated skipped stale <<< "$counts"
failed=0
if (( status != 0 )); then failed=1; fi
write_log "$files" "$duplicates" "$added" "$updated" "$skipped" "$stale" 0 "$failed"
if (( failed )); then printf 'Scheduled import failed (exit %d).\n' "$status" >&2; fi
exit "$status"
