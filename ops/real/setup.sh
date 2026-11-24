#!/bin/bash -p
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

validate_real_root
[[ $# == 0 ]] || fail 'Usage: setup.sh (set BGFIN_REAL_ROOT and optionally BGFIN_REAL_PORT).'
port=${BGFIN_REAL_PORT:-5007}
[[ $port =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || fail 'Set BGFIN_REAL_PORT to a port from 1 to 65535.'

export BGFIN_ACTUAL_DATA_DIR=$real_root/actual-data BGFIN_REAL_PORT=$port
export BGFIN_REAL_UID=$EUID BGFIN_REAL_GID
BGFIN_REAL_GID=$(id -g)
compose=("${local_docker[@]}" compose -p "$project" --env-file /dev/null
    -f "$repo/ops/docker/compose.yaml" -f "$ops_real/compose.override.yaml")
"${compose[@]}" version >/dev/null || fail 'Install Docker Compose v2.24.4 or later.'

mkdir -p -- "$real_root"
private_dir "$real_root"
# Serialize setup for this data root without introducing a lockfile.
exec 8< "$real_root"
flock -x 8

find_server
running=false
if [[ -n $server_id ]]; then
    check_server_data
    bindings=$(inspect_server '{{json .HostConfig.PortBindings}}')
    jq -e --arg port "$port" '. == {"5006/tcp": [{HostIp: "127.0.0.1", HostPort: $port}]}' \
        <<< "$bindings" >/dev/null || fail 'The real Actual server already has a different port binding.'
    running=$(inspect_server '{{.State.Running}}')
fi
if [[ $running == false ]]; then
    listeners=$(ss -H -ltn "sport = :$port") || fail 'Cannot check the local TCP port with ss.'
    [[ -z $listeners ]] || fail "TCP port $port is in use. Set BGFIN_REAL_PORT to an available port."
    network_id=$("${local_docker[@]}" network ls --quiet --filter "name=^${network}$")
    if [[ -n $network_id ]]; then
        [[ $network_id != *$'\n'* ]] || fail 'Expected one real Compose network.'
        network_labels=$("${local_docker[@]}" network inspect --format \
            '{{index .Labels "com.docker.compose.project"}}:{{index .Labels "com.docker.compose.network"}}' "$network_id")
        [[ $network_labels == "$project:default" ]] || fail 'The real Docker network name is already in use.'
    fi
fi

create_dir() {
    if [[ ! -e $1 && ! -L $1 ]]; then mkdir -m 700 -- "$1"; fi
    private_dir "$1"
}

copy_template() {
    local template=$1 destination=$2
    if [[ -e $destination || -L $destination ]]; then
        private_file "$destination"
        printf 'Kept %s\n' "$destination"
    else
        (set -o noclobber; cat -- "$template" > "$destination")
        private_file "$destination"
        printf 'Created %s\n' "$destination"
    fi
}

for directory in actual-data intake config intake/inbox intake/quarantine; do
    create_dir "$real_root/$directory"
done
copy_template "$ops_real/actual.env.example" "$real_root/config/actual.env"
copy_template "$ops_real/accounts.example.json" "$real_root/config/accounts.json"

job_id=$("${local_docker[@]}" image ls --quiet --filter "reference=$job_image")
if [[ -z $job_id ]]; then
    "${local_docker[@]}" build --tag "$job_image" --file "$repo/ops/docker/Dockerfile.job" "$repo" 8<&-
fi
if [[ $running == false ]]; then
    "${compose[@]}" up -d --wait --wait-timeout 75 --no-recreate --no-deps actual-server 8<&-
else
    printf 'Kept the running Actual server.\n'
fi

printf '\nActual is available at 127.0.0.1:%s on the cloud desktop.\n' "$port"
printf 'From the laptop, run: ssh -L %s:127.0.0.1:%s <cloud desktop host>\n' "$port" "$port"
printf 'Open http://localhost:%s and follow "Real budget setup (glossner)" in README.md.\n' "$port"
