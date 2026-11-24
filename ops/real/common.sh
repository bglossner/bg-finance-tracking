#!/bin/bash -p
set -euo pipefail
umask 077

fail() { printf 'Real budget: %s\n' "$1" >&2; exit 1; }

ops_real=$(dirname -- "$(realpath -e -- "${BASH_SOURCE[0]}")")
repo=${ops_real%/ops/real}
readonly project=bgfin-real network=bgfin-real_default job_image=bgfin-job:real
unset DOCKER_CONTEXT
readonly -a local_docker=(docker --host unix:///var/run/docker.sock)

validate_real_root() {
    local input=${BGFIN_REAL_ROOT-} temporary lexical ancestor
    [[ -n $input ]] || fail 'Set BGFIN_REAL_ROOT explicitly.'
    [[ $input == /* ]] || fail 'BGFIN_REAL_ROOT must be an absolute path.'
    temporary=$(realpath -e -- /tmp)
    IFS= read -r -d '' lexical < <(realpath -msz -- "$input") || fail 'Cannot resolve BGFIN_REAL_ROOT.'
    IFS= read -r -d '' real_root < <(realpath -mz -- "$input") || fail 'Cannot resolve BGFIN_REAL_ROOT.'
    case "$input:$real_root" in
        *$'\n'*|*$'\r'*|*,*) fail 'BGFIN_REAL_ROOT cannot contain commas or line breaks.' ;;
    esac
    [[ $lexical != /tmp && $lexical != /tmp/* && $real_root != "$temporary" && $real_root != "$temporary/"* ]] ||
        fail 'BGFIN_REAL_ROOT must be outside /tmp.'
    [[ $real_root != / && $repo != "$real_root/"* ]] || fail 'Choose a dedicated directory outside the checkout.'
    for ancestor in "$lexical" "$real_root"; do
        while :; do
            if [[ -e $ancestor/.git || -L $ancestor/.git ]]; then
                fail 'BGFIN_REAL_ROOT must be outside every Git checkout.'
            fi
            [[ $ancestor != / ]] || break
            ancestor=$(dirname -- "$ancestor")
        done
    done
    [[ ! -L $lexical ]] || fail 'Use a directory for BGFIN_REAL_ROOT, without a symlink at the root.'
}

private_dir() {
    local directory=$1
    [[ -d $directory && ! -L $directory && $(stat -c '%u:%a' -- "$directory") == "$EUID:700" ]] ||
        fail "Use an owner-only directory (0700) at $directory."
}

private_file() {
    local file=$1
    [[ -f $file && ! -L $file && $(stat -c '%u:%a:%h' -- "$file") == "$EUID:600:1" ]] ||
        fail "Use a private regular file (0600) at $file."
}

find_server() {
    server_id=$("${local_docker[@]}" ps --all --quiet --no-trunc \
        --filter "label=com.docker.compose.project=$project" \
        --filter label=com.docker.compose.service=actual-server) || fail 'Cannot query the local Docker daemon.'
    [[ $server_id != *$'\n'* ]] || fail 'Expected one Actual server in the real Compose project.'
}

inspect_server() {
    "${local_docker[@]}" container inspect --format "$1" "$server_id"
}

check_server_data() {
    local source
    source=$(inspect_server '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "bind")}}{{.Source}}{{end}}{{end}}') ||
        fail 'Cannot inspect the real Actual server.'
    [[ $source == "$real_root/actual-data" ]] || fail 'The real Actual server belongs to a different data root.'
}
