#!/bin/bash -p
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

validate_real_root
private_dir "$real_root"
private_dir "$real_root/intake"
find_server
if [[ -n $server_id ]]; then
    check_server_data
    inspect_server 'Actual state: {{.State.Status}}{{range (index .HostConfig.PortBindings "5006/tcp")}}{{printf "\nPort: %s:%s" .HostIp .HostPort}}{{end}}'
else
    printf 'Actual state: absent\nPort: none\n'
fi
for directory in inbox quarantine; do
    path=$real_root/intake/$directory
    private_dir "$path"
    count=$(find -P "$path" -type f -printf 'x\n' 2>/dev/null | awk 'END {print NR}') ||
        fail "Could not count files in $directory."
    printf '%s files: %s\n' "$directory" "$count"
done
