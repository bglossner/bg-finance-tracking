# Stop, back up, or wipe the real budget

Run these commands yourself on the cloud desktop. If a scheduler is active,
disable it and let any import finish before stopping or copying the stack.

From the repository root, use the same data root and port as setup. Docker
Compose v2.24.4 or later is required.

```sh
export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
export BGFIN_REAL_PORT=5007
export BGFIN_ACTUAL_DATA_DIR="$(realpath -e -- "$BGFIN_REAL_ROOT/actual-data")"
export BGFIN_REAL_UID="$(id -u)" BGFIN_REAL_GID="$(id -g)"
docker --host unix:///var/run/docker.sock compose -p bgfin-real --env-file /dev/null \
  -f ops/docker/compose.yaml -f ops/real/compose.override.yaml down
```

To make a consistent backup after the stack stops, archive the whole real
root to a private destination outside the root and all checkouts. The archive
includes credentials, statements, intake checkpoints, and the Actual budget.
Keep it in encrypted storage with owner-only access.

```sh
(umask 077; tar -C "$BGFIN_REAL_ROOT" -czf "$HOME/bgfin-real-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" .)
```

For an intentional wipe, verify the backup and inspect the printed path
before running the delete command separately. The command below is for the
default real root. A full wipe removes Actual data, the importer cache and
checkpoints, pending and archived statements, and local config. A subsequent
setup starts with an empty server again.

```sh
realpath -e -- "$HOME/.local/share/bg-finance-tracking/real"
```

```sh
rm -rI -- "$HOME/.local/share/bg-finance-tracking/real"
```
