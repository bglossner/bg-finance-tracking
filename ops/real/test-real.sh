#!/bin/bash -p
set -euo pipefail
umask 077
ops_real=$(dirname -- "$(realpath -e -- "$0")")
repo=${ops_real%/ops/real}
test_root=$(mktemp -d "$HOME/.bgfin-real-test.XXXXXX")
trap 'rm -rf -- "$test_root"' EXIT
export TEST_ROOT=$(realpath -e -- "$test_root")
export BGFIN_REAL_ROOT="$TEST_ROOT/real space" BGFIN_REAL_PORT=5999
mkdir -- "$TEST_ROOT/bin"
export PATH="$TEST_ROOT/bin:$PATH"

cat > "$TEST_ROOT/bin/docker" <<'STUB'
#!/bin/bash -p
set -euo pipefail
[[ $1 == --host && $2 == unix:///var/run/docker.sock ]]
shift 2
printf '%s\n' "$1" >> "$TEST_ROOT/docker-calls"
case "$1 $2" in
    'compose -p')
        [[ $3 == bgfin-real ]]
        case " $* " in
            *' version '*) ;;
            *' up '*--no-recreate*' actual-server '*) : > "$TEST_ROOT/running"; rm -f -- "$TEST_ROOT/unhealthy" ;;
            *) exit 11 ;;
        esac ;;
    'ps --all')
        if [[ " $* " == *' volume=/data '* ]]; then
            if [[ -e $TEST_ROOT/foreign-mount ]]; then printf 'fake-foreign-id\n'; fi
        else
            [[ " $* " == *' label=com.docker.compose.project=bgfin-real '* ]]
        fi
        if [[ -e $TEST_ROOT/running ]]; then printf 'fake-server-id\n'; fi ;;
    'network ls') ;;
    'image ls') [[ $5 == reference=bgfin-job:real ]]
        if [[ -e $TEST_ROOT/image ]]; then printf 'fake-image-id\n'; fi ;;
    'build --tag') [[ $3 == bgfin-job:real ]]; : > "$TEST_ROOT/image" ;;
    'container inspect')
        case "$4" in
            *'.Mounts'*) printf '%s\n' "$BGFIN_REAL_ROOT/actual-data" ;;
            '{{.State.Running}}') printf 'true\n' ;;
            *'.State.Health'*)
                if [[ -e $TEST_ROOT/unhealthy ]]; then printf 'unhealthy\n'; else printf 'healthy\n'; fi ;;
            '{{json .HostConfig.PortBindings}}') printf '%s\n' '{"5006/tcp":[{"HostIp":"127.0.0.1","HostPort":"5999"}]}' ;;
            'Actual state:'*) printf 'Actual state: running\nPort: 127.0.0.1:5999\n' ;;
            *'.NetworkSettings.Networks'*) printf 'fake-network-id\n' ;;
            *) exit 12 ;;
        esac ;;
    'run --rm')
        [[ " $* " == *' --network bgfin-real_default '* && " $* " == *' --log-driver none '* ]]
        [[ " $* " == *"source=$BGFIN_REAL_ROOT/intake,target=/intake "* ]]
        [[ " $* " == *"source=$BGFIN_REAL_ROOT/config/accounts.json,target=/config/accounts.json,readonly "* ]]
        [[ " $* " == *'bgfin-job:real -k 10s 10m node dist/src/inbox-cli.js --qfx-only '* ]]
        [[ " $* " == *' --env ACTUAL_SERVER_PASSWORD '* && " $* " != *'FAKE_PRIVATE'* ]]
        [[ $ACTUAL_SERVER_PASSWORD == 'FAKE_PRIVATE=$(touch INJECTION)' ]]
        printf '%s\n' 'synthetic: 1 files processed (0 duplicates), 2 added, 0 updated, 0 skipped, latest posted: 2026-01-01, next export from: 2025-12-29' \
            'synthetic: account is stale.' 'FAKE_PRIVATE raw diagnostic'
        exit "${TEST_JOB_STATUS:-0}" ;;
    *) exit 13 ;;
esac
STUB
cat > "$TEST_ROOT/bin/ss" <<'STUB'
#!/bin/bash -p
set -euo pipefail
[[ $* == '-H -ltn sport = :5999' ]]
if [[ -e $TEST_ROOT/busy-port ]]; then printf 'LISTEN\n'; fi
STUB
chmod 700 "$TEST_ROOT/bin/"*

refuse() {
    local expected=$1 output
    shift
    if output=$("$@" 2>&1) || [[ $output != *"$expected"* ]]; then
        printf 'FAIL expected refusal containing %s\n%s\n' "$expected" "$output" >&2
        exit 1
    fi
    printf 'PASS refusal: %s\n' "$expected"
}

refuse 'Set BGFIN_REAL_ROOT' env -u BGFIN_REAL_ROOT "$ops_real/setup.sh"
refuse 'absolute path' env BGFIN_REAL_ROOT=relative "$ops_real/setup.sh"
refuse 'outside /tmp' env BGFIN_REAL_ROOT=/tmp/do-not-create "$ops_real/setup.sh"
refuse 'outside every Git checkout' env BGFIN_REAL_ROOT="$repo/do-not-create" "$ops_real/setup.sh"
git init -q "$TEST_ROOT/other-checkout"
refuse 'outside every Git checkout' env BGFIN_REAL_ROOT="$TEST_ROOT/other-checkout/do-not-create" "$ops_real/setup.sh"
ln -s /tmp "$TEST_ROOT/tmp-link"
refuse 'outside /tmp' env BGFIN_REAL_ROOT="$TEST_ROOT/tmp-link/do-not-create" "$ops_real/setup.sh"
[[ ! -e $TEST_ROOT/docker-calls ]]

: > "$TEST_ROOT/foreign-mount"
refuse 'overlaps another container' "$ops_real/setup.sh"
[[ ! -e $BGFIN_REAL_ROOT ]]
rm -- "$TEST_ROOT/foreign-mount"
: > "$TEST_ROOT/busy-port"
refuse 'TCP port 5999 is in use' "$ops_real/setup.sh"
rm -- "$TEST_ROOT/busy-port"
"$ops_real/setup.sh"
for path in '' actual-data intake config intake/inbox intake/quarantine; do
    [[ $(stat -c '%u:%a' -- "$BGFIN_REAL_ROOT/$path") == "$EUID:700" ]]
done
for path in actual.env accounts.json; do
    [[ $(stat -c '%u:%a:%h' -- "$BGFIN_REAL_ROOT/config/$path") == "$EUID:600:1" ]]
done
printf 'PASS owner-only paths\n'

settings=$BGFIN_REAL_ROOT/config/actual.env
accounts=$BGFIN_REAL_ROOT/config/accounts.json
printf '# local settings marker\n' >> "$settings"
printf '\n' >> "$accounts"
before=$(sha256sum -- "$settings" "$accounts")
second=$("$ops_real/setup.sh")
[[ $second == *"Kept $settings"* && $second == *"Kept $accounts"* ]]
[[ $second == *'Kept the running Actual server.'* && $before == "$(sha256sum -- "$settings" "$accounts")" ]]
[[ $(grep -c '^build$' "$TEST_ROOT/docker-calls") == 1 ]]
printf 'PASS existing files and running server kept\n'
: > "$TEST_ROOT/unhealthy"
"$ops_real/setup.sh" > /dev/null
[[ ! -e $TEST_ROOT/unhealthy ]]
printf 'PASS retry waits for an unhealthy running server without recreation\n'

: > "$TEST_ROOT/docker-calls"
refuse 'no dry-run mode' "$ops_real/import.sh" --dry-run
refuse 'Set ACTUAL_SERVER_PASSWORD' "$ops_real/import.sh"
sed -i 's/^ACTUAL_SERVER_PASSWORD=$/ACTUAL_SERVER_PASSWORD=FAKE_PRIVATE=$(touch INJECTION)/' "$settings"
refuse 'Set ACTUAL_BUDGET_SYNC_ID' "$ops_real/import.sh"
sed -i 's/^ACTUAL_BUDGET_SYNC_ID=$/ACTUAL_BUDGET_SYNC_ID=fake-sync-id/' "$settings"
sed -i 's/^BGFIN_HISTORY_CUTOFF=YYYY-MM-DD$/BGFIN_HISTORY_CUTOFF=2025-06-01/' "$settings"
refuse 'Set each last4' "$ops_real/import.sh"
[[ ! -s $TEST_ROOT/docker-calls ]]
sed -i -e 's/XXXX/1234/g' -e 's/REPLACE_WITH_CHECKING_ACCOUNT/checking-id/' -e 's/REPLACE_WITH_CARD_ACCOUNT/checking-id/' "$accounts"
refuse 'Use a different actualAccount' "$ops_real/import.sh"
[[ ! -s $TEST_ROOT/docker-calls ]]
sed -i '/chase-card/s/checking-id/card-id/' "$accounts"
(
    cd "$TEST_ROOT"
    [[ $("$ops_real/import.sh") == 'files=1 duplicates=0 added=2 updated=0 skipped=0 stale=1' ]]
    [[ ! -e INJECTION ]]
    refuse 'Import failed (exit 9)' env TEST_JOB_STATUS=9 "$ops_real/import.sh"
)
printf 'PASS literal settings and aggregate import output\n'

printf '%s\n' 'FAKE_PRIVATE body' > "$BGFIN_REAL_ROOT/intake/inbox/FAKE_PRIVATE.qfx"
printf '%s\n' 'FAKE_PRIVATE quarantine reason' > "$BGFIN_REAL_ROOT/intake/quarantine/FAKE_PRIVATE.reason.txt"
ln -s "$settings" "$BGFIN_REAL_ROOT/intake/quarantine/linked-settings"
status=$("$ops_real/status.sh")
[[ $status == $'Actual state: running\nPort: 127.0.0.1:5999\ninbox files: 1\nquarantine files: 1' ]]
printf 'PASS status reports counts without filenames or contents\n'
