#!/usr/bin/env bash
# Disposable GitHub Linux runner only. Real SSH/PAM login + systemd user manager, not nohup smoke.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo 'CI-only service fixture' >&2; exit 1; }
archive="$(realpath "${1:?Usage: verify-service.sh archive}")"
work="$(mktemp -d)"
user="pilotci${GITHUB_RUN_ATTEMPT:-0}"
port=22222
sshd_pid=''
created_user=0
cleanup() {
	code=$?
	set +e
	if [ "$code" != 0 ]; then
		sudo cat "$work/sshd.log" 2>/dev/null
		if [ -n "${uid:-}" ]; then
			sudo journalctl "_UID=$uid" --no-pager -n 150
		fi
	fi
	if [ -n "$sshd_pid" ]; then sudo kill "$sshd_pid" 2>/dev/null || true; fi
	if [ "$created_user" = 1 ]; then
		sudo loginctl terminate-user "$user" || true
		sudo loginctl disable-linger "$user" || true
		sudo userdel -r "$user" || true
	fi
	rm -rf "$work"
}
trap cleanup EXIT
sudo useradd -m -s /bin/bash "$user"
created_user=1
sudo passwd -d "$user"
uid="$(id -u "$user")"
home="$(getent passwd "$user" | cut -d: -f6)"
sudo mkdir -p "$home/relocated release" "$home/.ssh" /run/sshd
sudo tar -xzf "$archive" -C "$home/relocated release"
ssh-keygen -q -t ed25519 -N '' -f "$work/key"
ssh-keygen -q -t ed25519 -N '' -f "$work/host"
sudo cp "$work/key.pub" "$home/.ssh/authorized_keys"
sudo chmod 700 "$home/.ssh"
sudo chmod 600 "$home/.ssh/authorized_keys"
sudo chown -R "$user:$user" "$home"
printf '[127.0.0.1]:%s %s\n' "$port" "$(cat "$work/host.pub")" > "$work/known_hosts"
cat > "$work/sshd_config" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $work/host
PidFile $work/sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
UsePAM yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $user
Subsystem sftp internal-sftp
EOF
sudo /usr/sbin/sshd -f "$work/sshd_config" -E "$work/sshd.log"
sshd_pid="$(sudo cat "$work/sshd.pid")"
ssh_cmd=(ssh -F /dev/null -i "$work/key" -p "$port" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$work/known_hosts" "$user@127.0.0.1")
runtime="$home/relocated release/runtime"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
bootstrap_source="$(base64 < "$repo/apps/macos/Sources/PilotCore/Resources/LinuxSSHBootstrap.py" | tr -d '\n')"
digest="$(sha256sum "$archive" | cut -d' ' -f1)"
size="$(stat -c %s "$archive")"
bootstrap() {
	"${ssh_cmd[@]}" "python3 -c \"import base64;exec(base64.b64decode('$bootstrap_source'))\" '$digest' '$size' null" < "$archive"
}
# No linger is an explicit setup failure, even while an SSH session makes the manager reachable.
set +e
"${ssh_cmd[@]}" "'$runtime/bin/pilot-runtime' probe" > "$work/no-linger.json"
code=$?
set -e
test "$code" = 2
python3 - "$work/no-linger.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert not r['ok'] and not next(x['ok'] for x in r['requirements'] if x['id'] == 'linger')
assert r['lingerSetup']['requiresPrivilege']
PY
# Exercise authenticated-package delivery's remote half before an explicit administrator grant.
set +e
bootstrap > "$work/bootstrap-no-linger.json"
code=$?
set -e
test "$code" = 2
python3 - "$work/bootstrap-no-linger.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r['code'] == 'prerequisites' and r['plan']['lingerSetup']['requiresPrivilege']
PY
# Explicit grant in this disposable fixture only, never performed by the production setup helper.
sudo loginctl enable-linger "$user"
sudo systemctl start "user@$uid.service"
bootstrap > "$work/bootstrap.json"
runtime="$home/.local/share/pilot/runtimes/$digest/runtime"
python3 - "$work/bootstrap.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r['ok'] and r['identity']['daemonId'] and r['identity']['lineageId']
assert r['service']['ActiveState'] == 'active'
PY
userctl() { sudo -u "$user" env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user "$@"; }
pid="$(userctl show pilotd.service --property=MainPID --value)"
test "$pid" -gt 0
# Simulate a lost final reply: replay setup, preserve the live PID and persistent identities.
bootstrap > "$work/bootstrap-repeated.json"
test "$(userctl show pilotd.service --property=MainPID --value)" = "$pid"
python3 - "$work/bootstrap.json" "$work/bootstrap-repeated.json" <<'PY'
import json, sys
assert json.load(open(sys.argv[1]))['identity'] == json.load(open(sys.argv[2]))['identity']
PY
# Every SSH session has ended. Do not keep a helper login alive to hide missing linger.
for attempt in $(seq 1 30); do
	sessions="$(sudo loginctl show-user "$user" --property=Sessions --value)"
	[ -z "$sessions" ] && break
	sleep 1
done
test -z "$sessions"
sleep 3
test "$(userctl show pilotd.service --property=MainPID --value)" = "$pid"
userctl is-enabled pilotd.service
userctl is-active pilotd.service
for attempt in $(seq 1 60); do
	if curl -fsS http://127.0.0.1:4319/api/hello > "$work/hello.json"; then break; fi
	sleep 1
done
python3 - "$work/hello.json" <<'PY'
import json, sys
h = json.load(open(sys.argv[1]))
assert h['platform'] == 'linux' and h['arch'] == 'x64' and h['capabilities']['independentExecution']
assert h['capabilities']['coordinatorIsolation']
PY
# Reconnect sees the same daemon. SIGTERM is orderly, not timeout/SIGKILL, and identity persists.
"${ssh_cmd[@]}" "'$runtime/bin/pilot-runtime' status; '$runtime/bin/pilot-runtime' stop"
test "$(userctl show pilotd.service --property=ExecMainStatus --value)" = 0
test "$(userctl show pilotd.service --property=Result --value)" = success
test "$(userctl show pilotd.service --property=MainPID --value)" = 0
"${ssh_cmd[@]}" "'$runtime/bin/pilot-runtime' start"
for attempt in $(seq 1 60); do
	if curl -fsS http://127.0.0.1:4319/api/hello > "$work/hello-restarted.json"; then break; fi
	sleep 1
done
python3 - "$work/hello.json" "$work/hello-restarted.json" <<'PY'
import json, sys
assert json.load(open(sys.argv[1]))['daemonId'] == json.load(open(sys.argv[2]))['daemonId']
PY
"${ssh_cmd[@]}" "'$runtime/bin/pilot-runtime' stop"
# Disposable saved workspace with no model/provider requirement, loaded on the following manager restart.
update_session="$(node -e 'console.log(crypto.randomUUID())')"
"${ssh_cmd[@]}" "mkdir -p '$home/.local/share/pilot/sessions/$update_session'; printf '%s' '{\"id\":\"$update_session\",\"cwd\":\"$home\",\"title\":\"Update fixture\",\"createdAt\":1,\"updatedAt\":1,\"working\":false}' > '$home/.local/share/pilot/sessions/$update_session/meta.json'"
sudo systemctl stop "user@$uid.service"
sudo systemctl start "user@$uid.service"
for attempt in $(seq 1 60); do
	if curl -fsS http://127.0.0.1:4319/api/hello > "$work/hello-manager-restarted.json"; then break; fi
	sleep 1
done
userctl is-active pilotd.service
python3 - "$work/hello.json" "$work/hello-manager-restarted.json" <<'PY'
import json, sys
assert json.load(open(sys.argv[1]))['daemonId'] == json.load(open(sys.argv[2]))['daemonId']
PY
node "$repo/scripts/linux/verify-update.mjs" "$home" "$archive" "$update_session" "$bootstrap_source" "${ssh_cmd[@]:1}" > "$work/update.json"
runtime="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["runtime"])' "$work/update.json")"
userctl is-active pilotd.service
"${ssh_cmd[@]}" "'$runtime/bin/pilot-runtime' stop"
sudo systemctl stop "user@$uid.service"
sudo systemctl start "user@$uid.service"
for attempt in $(seq 1 60); do
	if curl -fsS http://127.0.0.1:4319/api/runtime-update > "$work/update-restarted.json"; then break; fi
	sleep 1
done
python3 - "$work/update.json" "$work/update-restarted.json" <<'PY'
import json, sys
before, after = [json.load(open(x)) for x in sys.argv[1:]]
assert before['id'] == after['id'] and after['phase'] == 'completed'
PY
"${ssh_cmd[@]}" "'$runtime/bin/pilot-runtime' stop"
echo 'Relocated production service: SSH logout survival, reconnect, orderly stop, durable identity restart passed.'
