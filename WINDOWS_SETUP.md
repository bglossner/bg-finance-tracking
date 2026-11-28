# Real budget on Windows 11 and WSL 2

Run this setup as glossner on the Windows computer that will hold the budget. Use Windows PowerShell for `wsl.exe` commands and the Ubuntu shell for Bash commands. Examples use the distro `Ubuntu-24.04`, the checkout `~/github/bg-finance-tracking`, and port `5007`.

## Prerequisites

- [ ] Windows 11 with current WSL and Ubuntu 24.04 LTS in WSL 2 mode. On an employer-managed machine, check policy for WSL, Docker, local personal financial data, and backups before installing or storing anything.
- [ ] Administrator access for WSL installation or updates as needed, and `sudo` access inside Ubuntu. Run the budget scripts as the regular Ubuntu user.
- [ ] GitHub read access and the real-setup commits available on GitHub. Glossner pushes `task-finance-real-setup`, or publishes `main` after merging the real-setup work, before cloning here.
- [ ] Docker Engine 28 or later with the Compose plugin 2.24.4 or later, plus an encrypted backup destination.

## 1. Prepare WSL

In PowerShell, check the WSL version and distro, and update WSL if needed. Systemd requires WSL 0.67.6 or later. A current WSL release is preferable.

```powershell
wsl.exe --version
wsl.exe --list --verbose
wsl.exe --update
```

If Ubuntu 24.04 is absent, install it from an administrator PowerShell, restart Windows if prompted, and launch the distro to create the Linux user. If the distro already exists but the list says version `1`, use `wsl.exe --set-version Ubuntu-24.04 2` to convert it. Use the registered name in all later `wsl.exe` commands if it differs.

```powershell
wsl.exe --install -d Ubuntu-24.04
wsl.exe -d Ubuntu-24.04
```

In Ubuntu, check PID 1. If it is already `systemd`, skip to Docker installation. Otherwise, install the systemd packages and edit `/etc/wsl.conf`. Add or update the `[boot]` section while preserving any existing settings.

```bash
ps -p 1 -o comm=
sudo apt-get update
sudo apt-get install -y systemd systemd-sysv nano
sudo nano /etc/wsl.conf
```

```ini
[boot]
systemd=true
```

From PowerShell, restart WSL after editing. `--shutdown` stops every running WSL distro and its services. Finish any other WSL work before running it. Confirm the new Ubuntu session shows `systemd` as PID 1.

```powershell
wsl.exe --shutdown
wsl.exe -d Ubuntu-24.04 -- ps -p 1 -o comm=
wsl.exe -d Ubuntu-24.04
```

[Microsoft WSL installation](https://learn.microsoft.com/en-us/windows/wsl/install) · [Systemd on WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd)

## 2. Install Docker Engine inside Ubuntu

Use Docker Engine in the same distro as the checkout. The real scripts connect to `/var/run/docker.sock` and compare the daemon's reported `/data` bind source with the canonical Linux path. A native engine puts the client, daemon, and files in that distro. Docker Desktop's WSL 2 backend offers a Windows GUI and CLI integration, and Docker handles bind mounts across its own daemon environment. Compatibility with the scripts' exact path checks would need a separate test. Install one Docker stack.

Docker Desktop is free for personal use, education, non-commercial open source, and small businesses with **fewer than 250 employees and less than US $10 million in annual revenue**. Professional use outside the small-business criteria and use by government entities require a paid subscription. On an employer-managed machine, also check employer policy. These are Desktop terms. [Docker Desktop licensing](https://docs.docker.com/subscription/desktop-license/) · [WSL 2 backend](https://docs.docker.com/desktop/features/wsl/) · [Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)

In Ubuntu, use Docker's official Apt repository. The commands assume a clean Docker install. If Ubuntu already has Docker, Podman compatibility packages, or a separately managed container runtime, review Docker's conflicting-package list and resolve the conflict before running this block.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF_APT
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF_APT
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now containerd.service docker.service
sudo usermod -aG docker "$(id -un)"
exit
```

Reopen Ubuntu from PowerShell as the same user. Check the supplementary groups and run the sample against the exact socket that the real scripts use. The `docker` group grants root-equivalent access in Ubuntu. Grant it only to the account that needs it and keep the socket's default protection. Use a regular login for setup and scheduling so file ownership and the primary group match that account.

```bash
id
unset DOCKER_CONTEXT
docker --host unix:///var/run/docker.sock version --format '{{.Server.Version}}'
docker --host unix:///var/run/docker.sock compose version --short
docker --host unix:///var/run/docker.sock run --rm hello-world
```

Check that the server is at least `28.0.0` and Compose is at least `2.24.4`. The Compose override uses `!override`. Older Docker releases have a documented same-network bypass for loopback-published ports. With systemd, Docker starts when the distro boots. A deliberately manual install can start the daemon in a dedicated Ubuntu terminal with `sudo dockerd` while `docker.service` is stopped, but the scheduling steps below assume the enabled systemd service. [Docker Ubuntu install](https://docs.docker.com/engine/install/ubuntu/) · [Linux post-install steps](https://docs.docker.com/engine/install/linux-postinstall/) · [Daemon startup](https://docs.docker.com/engine/daemon/start/) · [Port publishing](https://docs.docker.com/engine/network/port-publishing/) · [Compose override](https://docs.docker.com/reference/compose-file/merge/#replace-value)

## 3. Clone and install the toolchain

Clone from Ubuntu into the Linux filesystem. Use the GitHub clone URL from glossner's repository. The second line selects `task-finance-real-setup` by default. Change it to `ref=main` if the real-setup commits are already on GitHub's `main`.

```bash
sudo apt-get install -y git jq iproute2 util-linux nano
ref=task-finance-real-setup
read -r -p 'GitHub clone URL: ' repo_url
mkdir -p "$HOME/github"
git clone --config core.autocrlf=false --branch "$ref" -- "$repo_url" "$HOME/github/bg-finance-tracking"
cd "$HOME/github/bg-finance-tracking"
findmnt -n -o FSTYPE -T "$PWD"
```

Keep both the checkout and the real root on WSL's Linux filesystem. The last command should report `ext4` for the Ubuntu checkout. Windows drives such as `/mnt/c` use DrvFS, where Unix modes depend on mount metadata and Windows permissions. The scripts check exact `0700` directories and `0600` single-link config files and depend on Linux locking and rename behavior. Use the Windows drive only as a source for finished downloads. In Windows Explorer, `\\wsl$\Ubuntu-24.04\home\<linux-user>` or `\\wsl.localhost\Ubuntu-24.04\home\<linux-user>` opens the Linux home. Edit private files from Ubuntu with `nano` to preserve Unix line endings and file modes. [WSL filesystems](https://learn.microsoft.com/en-us/windows/wsl/filesystems) · [DrvFS permissions](https://learn.microsoft.com/en-us/windows/wsl/file-permissions) · [Linux flock](https://man7.org/linux/man-pages/man1/flock.1.html)

Docker runs the real importer with the project-pinned Node version and native SQLite dependencies. Host Node is optional for this workflow. For local development checks, install mise and explicitly use the `.nvmrc` version. Ubuntu 24.04's glibc 2.39 is a better starting point for the native dependency than Amazon Linux 2. Host binding support still depends on architecture, Node ABI, and a working native build toolchain. The build tools below provide Python 3, `make`, and a C++ compiler if `npm ci` compiles the binding. `iproute2` provides `ss` and `util-linux` provides `flock`.

```bash
sudo apt-get install -y build-essential python3
curl -fsSL https://mise.run | sh
"$HOME/.local/bin/mise" install node@26.12.1
"$HOME/.local/bin/mise" exec node@26.12.1 -- node --version
"$HOME/.local/bin/mise" exec node@26.12.1 -- bash -c 'npm ci && npm run build && npm test'
```

[mise installation](https://mise.jdx.dev/installing-mise.html) · [mise Node support](https://mise.jdx.dev/lang/node.html) · [Ubuntu libc6](https://packages.ubuntu.com/noble/libc6) · [node-gyp prerequisites](https://github.com/nodejs/node-gyp#on-unix)

## 4. Start Actual and verify local access

In Ubuntu, set the same real root in each new shell before running these scripts. Keep it outside `/tmp` and every Git checkout. Run all budget commands under the same regular Linux user. Keep an Ubuntu terminal open while using Actual in the Windows browser. After reboot or WSL shutdown, reopen Ubuntu and rerun setup to start Actual.

Before the first setup, check PowerShell for existing Windows listeners with `Get-NetTCPConnection -LocalPort 5007 -State Listen -ErrorAction SilentlyContinue`. If another application already owns the port, resolve the conflict before using Actual.

```bash
cd "$HOME/github/bg-finance-tracking"
export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
export BGFIN_REAL_PORT=5007
ops/real/setup.sh
ops/real/status.sh
curl -fsS http://127.0.0.1:5007/health
```

Setup creates the private directories and templates, builds `bgfin-job:real` if absent, and starts the loopback-only `bgfin-real` stack. Keep the default port throughout this guide. If a different port is required, use the same `BGFIN_REAL_PORT` in setup, the scheduled launcher and backup commands, and substitute it in the URLs and checks. Setup prints SSH instructions for a separate cloud desktop. On this Windows computer, open [Actual Budget](http://localhost:5007) directly. For the default NAT mode, WSL's `localhostForwarding` defaults to `true`.

Before entering data, `status.sh` should show `127.0.0.1:5007` as the only published binding. From Windows PowerShell, verify that the loopback health URL works and check for existing port-proxy rules. Keep the firewall enabled and port `5007` out of Windows or Hyper-V inbound allow rules and port proxies. With the default NAT and Docker bridge settings, Docker 28+, and the loopback binding, this setup gives other LAN machines no route to the published endpoint. If a second Windows computer is available on the LAN, run `Test-NetConnection -ComputerName <Windows-LAN-IP> -Port 5007 -InformationLevel Quiet` from there, substituting the first computer's LAN address. Expect `False`. Resolve any successful LAN probe before entering financial data.

```powershell
curl.exe --fail http://127.0.0.1:5007/health
netsh interface portproxy show all
Get-NetTCPConnection -LocalPort 5007 -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, OwningProcess
```

If WSL uses mirrored networking, IPv4 loopback is supported and the NAT-only `localhostForwarding` flag is ignored. Mirrored mode can allow direct LAN ingress to Linux listeners. Keep the existing firewall protections, use IPv4 loopback, and verify local and LAN access separately. To use default NAT where policy permits, open `%UserProfile%\.wslconfig` with `notepad.exe "$env:USERPROFILE\.wslconfig"` in PowerShell, set `networkingMode=nat` and `localhostForwarding=true` under `[wsl2]`, and use the restart in step 1. This setting applies to all WSL 2 distros. [Microsoft WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking) · [WSL settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) · [Hyper-V firewall](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall) · [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)

## 5. Create the budget and import the first exports

1. In the Windows browser, set the Actual server password, create the budget, and add separate Chase checking and credit card accounts with zero opening balances. Use the first date to import as the configured cutoff. The first successful QFX import with no checkpoint and a valid `LEDGERBAL` sets the starting balance automatically. [Actual reconciliation](https://actualbudget.org/docs/accounts/reconciliation/)
2. In Actual, open **Settings > Advanced** and copy the **Sync ID**. Open each account and take its account ID from the URL. Use a different ID for each alias. [Starting a budget](https://actualbudget.org/docs/getting-started/starting-fresh/) · [Actual account setup](https://actualbudget.org/docs/accounts/) · [Actual settings](https://actualbudget.org/docs/settings/#advanced-settings)
3. In Ubuntu, edit the two private templates. In `actual.env`, fill in `ACTUAL_SERVER_PASSWORD`, `ACTUAL_BUDGET_SYNC_ID`, and `BGFIN_HISTORY_CUTOFF` (`YYYY-MM-DD`). Keep `ACTUAL_SERVER_URL=http://actual-server:5006` and `BGFIN_DOCKER_NETWORK=bgfin-real_default`. For an encrypted budget, add `ACTUAL_E2E_PASSWORD`. Enter one literal `KEY=value` per line, with the value immediately after `=` and without shell quotes. In `accounts.json`, replace each `actualAccount` placeholder, set each `last4` to the real four-digit suffix, and replace `XXXX` in each filename glob to match the corresponding Chase QFX basename.

   ```bash
   export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
   nano "$BGFIN_REAL_ROOT/config/actual.env"
   nano "$BGFIN_REAL_ROOT/config/accounts.json"
   chmod 600 "$BGFIN_REAL_ROOT/config/actual.env" "$BGFIN_REAL_ROOT/config/accounts.json"
   jq -e 'type == "object"' "$BGFIN_REAL_ROOT/config/accounts.json" >/dev/null
   ```

4. Download and drop each first QFX using the weekly routine below, starting from the cutoff date, inclusive. Optionally preview a single QFX offline inside Ubuntu. Run `ops/real/import.sh` and look for `balance check: matches as of` for each alias. Review pending or quarantined files before advancing the export window. [Single-file preview](README.md#real-budget-setup-glossner)

5. To correct an existing account, open the updated checkout in Ubuntu and
   rebuild the import image. Download a fresh QFX for the intended account and
   drop it using section 6. Wait for the configured minimum file age, then
   run the reset for the alias. Repeat for the card with `chase-card`.

   ```bash
   cd "$HOME/github/bg-finance-tracking"
   export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
   docker --host unix:///var/run/docker.sock build --tag bgfin-job:real -f ops/docker/Dockerfile.job .
   ops/real/import.sh --set-starting-balance chase-checking
   ```

   Expect `balance check: matches as of <date>`. An ambiguous starting balance
   requires reviewing the opening transactions in Actual before retrying.

## 6. Drop Chase exports weekly

1. In the Windows browser, sign in to Chase, open each account's **Activity**, and use its download option to save a completed **Quicken Web Connect (`.qfx`)** export into Windows Downloads. Export from the chosen start date, inclusive, through the newest available posted activity. Use a preset only if it covers that entire window and starts on or after the cutoff. The cutoff sets the first export date and the opening balance boundary. The importer processes all rows in the file, including any earlier dates. Leave the account pending if Chase offers no QFX for the needed date range.
2. To read the next export dates privately, use this in Ubuntu. It subtracts three days from each account's successful checkpoint and uses the cutoff as the earliest date. An alias without a checkpoint starts at the cutoff. Check these dates before choosing the window for the next download.

   ```bash
   export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
   state="$BGFIN_REAL_ROOT/intake/state/accounts.json"
   cutoff=$(sed -n 's/^BGFIN_HISTORY_CUTOFF=\(.*\)$/\1/p' "$BGFIN_REAL_ROOT/config/actual.env" | tr -d '\r')
   jq -r 'keys[]' "$BGFIN_REAL_ROOT/config/accounts.json" | while IFS= read -r alias; do
     latest=''
     if [ -f "$state" ]; then latest=$(jq -r --arg alias "$alias" '.[$alias].latestPostedDate // empty' "$state") || exit 1; fi
     next=$cutoff
     if [ -n "$latest" ]; then
       overlap=$(date -u -d "$latest 3 days ago" +%F) || exit 1
       if [[ $overlap > $cutoff ]]; then next=$overlap; fi
     fi
     printf '%s\t%s\n' "$alias" "$next"
   done
   ```

3. Use this WSL helper to copy one selected, completed QFX at a time from `C:\Users\<Windows-user>\Downloads` into the Linux inbox. Paste its WSL path at the prompt, for example `/mnt/c/Users/YourWindowsUser/Downloads/Chase1234_Activity.qfx`. Confirm the file covers the intended account and dates before dropping it. The copy uses a private `.part` file and publishes the final name by rename in the same directory. An existing name is preserved. If that happens, confirm which download belongs there or choose a distinct basename that still matches the account glob.

   ```bash
   (
     set -e
     umask 077
     read -r -p 'Completed QFX path under /mnt/c: ' src
     case "$src" in /mnt/c/*.[qQ][fF][xX]) ;; *) echo 'Choose a completed QFX on C:.' >&2; exit 1 ;; esac
     inbox="$HOME/.local/share/bg-finance-tracking/real/intake/inbox"
     part=$(mktemp -- "$inbox/.drop.XXXXXXXX.part")
     trap 'rm -f -- "$part"' EXIT
     cp -T -- "$src" "$part"
     mv -nT -- "$part" "$inbox/${src##*/}"
     if [ -e "$part" ]; then echo 'That filename is already in the inbox.' >&2; exit 1; fi
   )
   ```

4. Wait at least ten seconds since the last copy, or longer if `BGFIN_MIN_FILE_AGE_SECONDS` is higher. Let the next scheduled run pick it up, or run the following from Ubuntu. The import wrapper prints aggregate counts and each file's balance check. An interactive terminal shows the signed difference on a mismatch. The scheduled log records the status and date. A mismatch leaves the opening amount as it was and the import still succeeds. `status.sh` counts regular files in the inbox and quarantine, including `.reason.txt` files. Inspect quarantine locally, and retry sync failures after checking the server and pending input. Keep the original download until the import and balance check succeed. Reconcile transfers and card payments across both accounts in Actual. [Actual reconciliation](https://actualbudget.org/docs/accounts/reconciliation/) · [Actual transfers](https://actualbudget.org/docs/transactions/transfers/)

   ```bash
   cd "$HOME/github/bg-finance-tracking"
   export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
   ops/real/import.sh
   ops/real/status.sh
   ```

## 7. Schedule hourly imports from Windows

Use Windows Task Scheduler with the same Windows sign-in that registered the Ubuntu distro. A scheduled `wsl.exe` invocation can start a stopped distro. A systemd user timer only runs while WSL is alive. `loginctl enable-linger` starts the user manager on distro boot and keeps it past Linux logout, but systemd services do not keep WSL alive. `Persistent=true` catches missed calendar work when that user timer starts again. Use only one scheduler. [WSL systemd lifecycle](https://devblogs.microsoft.com/commandline/systemd-support-is-now-available-in-wsl/) · [loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html) · [systemd timers](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)

After the first successful manual import, create this local launcher inside Ubuntu. It waits for Docker's socket, reruns setup to start Actual if WSL was stopped, and then calls the real importer with the required root. The latest run replaces a private log, and the exit status reaches Task Scheduler. The launcher assumes the default checkout, root, and port shown in this guide.

```bash
mkdir -p "$HOME/.local/bin"
(umask 077; cat > "$HOME/.local/bin/bgfin-real-scheduled" <<'EOF_JOB'
#!/bin/bash -p
set -euo pipefail
export PATH=/usr/bin:/bin
umask 077
unset DOCKER_CONTEXT
export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
export BGFIN_REAL_PORT=5007
cd "$HOME/github/bg-finance-tracking"
exec > "$BGFIN_REAL_ROOT/intake/windows-task.log" 2>&1
date -u +'%FT%TZ'
timeout 60 /bin/bash -c 'until docker -H unix:///var/run/docker.sock info >/dev/null 2>&1; do sleep 2; done' || {
  echo 'Docker socket unavailable after 60 seconds.' >&2
  exit 1
}
ops/real/setup.sh
exec ops/real/import.sh
EOF_JOB
chmod 700 "$HOME/.local/bin/bgfin-real-scheduled")
printf -- '-d Ubuntu-24.04 -u %s -- /bin/bash -p "%s/.local/bin/bgfin-real-scheduled"\n' "$(id -un)" "$HOME"
```

In Windows, open **Task Scheduler** (`taskschd.msc`) and choose **Create Task**, with these settings.

| Tab | Settings |
| --- | --- |
| **General** | Name `BGFin Real Import`. Under **Security options**, use the same Windows account as above, select **Run only when user is logged on**, and leave **Run with highest privileges** unchecked. |
| **Triggers** | **New**, **On a schedule**, **One time**, pick a start a few minutes in the future, check **Repeat task every** `1 hour` **for a duration of** `Indefinitely`, and leave **Enabled** checked. |
| **Actions** | **New**, **Start a program**. **Program/script** is `%SystemRoot%\System32\wsl.exe`. **Add arguments** is the printed `-d ...` line, with the registered distro name. Leave **Start in** blank. |
| **Conditions** | Clear **Start the task only if the computer is on AC power** if it should run on battery. Leave **Wake the computer to run this task** unchecked unless glossner wants scheduled wakes and the computer supports them. |
| **Settings** | Enable **Allow task to be run on demand** and **Run task as soon as possible after a scheduled start is missed**. Set **Stop the task if it runs longer than** `30 minutes` and **If the task is already running** to **Do not start a new instance**. |

Save, then right-click the task and choose **Run**. When it finishes, check for **Last Run Result** `0x0` and read the latest log in Ubuntu with `tail -n 12 "$HOME/.local/share/bg-finance-tracking/real/intake/windows-task.log"`. For a cold-start check, close Actual, wait for every WSL job to finish, use `wsl.exe --shutdown` in PowerShell, then choose **Run** again and verify a fresh UTC timestamp and a successful result. With these settings, imports wait while Windows is off, and the task requires a signed-in Windows session. A successful scheduled import with an empty inbox is normal. [Task action fields](https://learn.microsoft.com/en-us/windows/win32/taskschd/execaction) · [Task repetition](https://learn.microsoft.com/en-us/windows/win32/taskschd/repetitionpattern) · [Missed starts](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable) · [Interactive sign-in](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype)

## 8. Back up and restore

For either a backup or a restore, disable **BGFin Real Import**, wait for all scheduled and manual imports to finish, and close Actual browser tabs after verifying changes have synced. Stop the stack as the same Ubuntu user using this complete block. Proceed once Compose has successfully removed the server or confirmed the project is already absent.

```bash
(
  set -euo pipefail
  umask 077
  cd "$HOME/github/bg-finance-tracking"
  export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
  export BGFIN_REAL_PORT=5007 BGFIN_ACTUAL_DATA_DIR BGFIN_REAL_UID BGFIN_REAL_GID
  BGFIN_ACTUAL_DATA_DIR=$(realpath -m -- "$BGFIN_REAL_ROOT/actual-data")
  BGFIN_REAL_UID=$(id -u)
  BGFIN_REAL_GID=$(id -g)
  unset DOCKER_CONTEXT
  docker --host unix:///var/run/docker.sock compose -p bgfin-real --env-file /dev/null \
    -f ops/docker/compose.yaml -f ops/real/compose.override.yaml down
)
```

For a backup, archive the whole real root, which contains the server data, statements, checkpoints, logs, and passwords. This creates a private staging copy in the Linux home. Use encrypted storage for the staging location or its underlying Windows volume, copy the archive to an encrypted destination outside the computer, and keep access restricted.

```bash
(
  set -euo pipefail
  umask 077
  cd "$HOME/github/bg-finance-tracking"
  export BGFIN_REAL_ROOT="$HOME/.local/share/bg-finance-tracking/real"
  export BGFIN_REAL_PORT=5007
  archive=$(mktemp "$HOME/bgfin-real-$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX.tar.gz")
  trap 'rm -f -- "$archive"' EXIT
  tar -C "$BGFIN_REAL_ROOT" -czf "$archive" .
  tar -tzf "$archive" >/dev/null
  trap - EXIT
  printf 'Backup: %s\n' "$archive"
  ops/real/setup.sh
)
```

Verify the copied archive is readable and retain an off-machine copy before enabling the task again. **Settings > Export > Export data** produces a budget-only ZIP. Store this unencrypted ZIP in encrypted storage as well. [Project backup notes](ops/real/teardown.md) · [Actual backup](https://actualbudget.org/docs/backup-restore/backup/)

For a restore, follow the stop procedure, then extract the trusted archive as the regular Linux user into a fresh mode-700 directory on the same Linux filesystem. Move the current root aside if it exists and move the extracted directory to the original `~/.local/share/bg-finance-tracking/real` path. Before reopening Actual, preserve any newer budget data glossner needs separately, then clear Actual's site data for the local origin in each previously used browser profile. Clear the `127.0.0.1` origin too if it was used. Otherwise, a previously synced browser copy can send newer transactions back into the restored budget. Rerun step 4, open the restored server in a fresh browser profile first, and verify ownership, modes, and balances before enabling the scheduler again. [Actual restore](https://actualbudget.org/docs/backup-restore/restore/) · [Actual sync after a restore](https://actualbudget.org/docs/getting-started/sync#what-does-resetting-sync-mean)

## Troubleshooting

| Symptom | Check in the affected shell |
| --- | --- |
| Docker permission denied | In Ubuntu run `id`, `ls -l /var/run/docker.sock`, and `systemctl status docker`. If group membership is missing, run `sudo usermod -aG docker "$(id -un)"` and reopen Ubuntu. Check that the scheduled action uses the same Linux user. Keep the socket permissions and run budget scripts as that user. |
| WSL starts without systemd | Check `wsl.exe --version` and `wsl.exe --list --verbose` in PowerShell. In Ubuntu, verify the `systemd-sysv` package and the `[boot]` setting in `/etc/wsl.conf`. After edits, run `wsl.exe --shutdown`, reopen the intended distro, and check `ps -p 1 -o comm=` again. |
| Port `5007` unreachable | Keep Ubuntu open. Run setup, then status and the Linux `/health` check. If only the Windows check fails, use [IPv4 loopback](http://127.0.0.1:5007), inspect port conflicts in Windows and in Ubuntu (`ss -H -ltn 'sport = :5007'`), and check `%UserProfile%\.wslconfig`. For NAT, `localhostForwarding=true` belongs under `[wsl2]`. Use `wsl.exe --shutdown` after changes, then restart Ubuntu and setup. |
| An env file has CRLF or the import reports an unexpected key | Edit in Ubuntu with `nano` and save as UTF-8 with LF and no byte-order mark. The real wrapper strips a trailing CR from each line, while the older scheduling wrapper reads literal lines without that cleanup. To convert CRLF privately, use `sed -i 's/\r$//' "$BGFIN_REAL_ROOT/config/actual.env"` and check mode `600` again. Re-create UTF-16 or BOM-marked files as plain UTF-8 if needed. |
| Clock or timezone looks wrong | Compare `date -u` and `timedatectl status` in Ubuntu with `(Get-Date).ToUniversalTime().ToString('u')` in PowerShell. Fix Windows time first. After resume or a clock drift, finish imports, close Actual, run `wsl.exe --shutdown`, then restart Ubuntu, run setup, and recheck UTC. If only Ubuntu's display zone differs, use `timedatectl list-timezones` and `sudo timedatectl set-timezone Region/City`. Task Scheduler uses the Windows schedule, and the importer uses UTC dates for staleness. |

## What agents never see

Glossner signs in to Chase, sets the Actual password and budget, edits the private mappings, handles statements, and opens the backups. Share only aggregate counts or errors with identifying details removed. Keep Chase and Actual sessions, QFX files, account IDs and suffixes, passwords, the Sync ID, and the real root out of agent sessions and Git. Owner-only modes still allow programs running as glossner to read those files.
