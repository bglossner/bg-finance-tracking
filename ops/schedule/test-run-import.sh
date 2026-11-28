#!/bin/bash
set -euo pipefail
umask 077
wrapper=$(realpath "$(dirname "$0")/run-import.sh")
repo=${wrapper%/ops/schedule/run-import.sh}
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
mkdir "$test_root/data"
printf 'ACTUAL_SERVER_PASSWORD=$(touch %s)\n' "$test_root/executed" > "$test_root/settings"
export BGFIN_ENV_FILE=$test_root/settings

refuse() {
    local expected=$1 output
    shift
    if output=$("$@" 2>&1); then
        printf 'Unexpected success for %s\n' "$expected" >&2
        exit 1
    fi
    [[ $output == *"$expected"* ]]
    printf 'PASS refusal: %s\n' "$expected"
}

refuse 'Set BGFIN_DATA_DIR' env -u BGFIN_DATA_DIR "$wrapper"
refuse 'outside the checkout' env BGFIN_DATA_DIR="$repo" "$wrapper"
refuse 'outside the checkout' env BGFIN_DATA_DIR="$(dirname "$repo")" "$wrapper"
export BGFIN_DATA_DIR=$test_root/data
chmod 0640 "$BGFIN_ENV_FILE"
refuse 'private owner-only environment file' "$wrapper"
chmod 0600 "$BGFIN_ENV_FILE"
log=$BGFIN_DATA_DIR/logs/import.log
grep -Eq ' files=0 duplicates=0 added=0 updated=0 skipped=0 stale=0 balance_mismatches=0 busy=0 failures=1$' "$log"
lock=$BGFIN_DATA_DIR/scheduled-import.lock
mkfifo "$lock"
refuse 'Invalid schedule lockfile' timeout 3 "$wrapper"
rm -- "$lock"

lock=$BGFIN_DATA_DIR/scheduled-import.lock
: > "$lock"
exec 3< "$lock"
flock -n 3
"$wrapper"
[[ $(wc -l < "$log") == 3 ]]
grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z files=0 duplicates=0 added=0 updated=0 skipped=0 stale=0 balance_mismatches=0 busy=1 failures=0$' "$log"
[[ ! -e $test_root/executed && ! -e $BGFIN_DATA_DIR/inbox ]]
printf 'PASS held lock, literal secret, and counts-only log\n'
