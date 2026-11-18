#!/usr/bin/env bash
# Swap update of the personal Pilot install: quit the GUI, stop the daemon, swap the app, start the daemon,
# reopen the GUI. Usage: install.sh BUILD. Refuses while any chat is working.
set -euo pipefail
BUILD="$1"
ROOT="${PILOT_BUILD_ROOT:-/tmp/day-build}"
NEW="$ROOT/$BUILD/app/Pilot.app"
APP="$HOME/Applications/Pilot.app"
RECORD="$HOME/Applications/Pilot-install-$BUILD"
LABEL="gui/$(id -u)/com.babariviere.pilot.daemon"
PLIST="$HOME/Library/LaunchAgents/com.babariviere.pilot.daemon.plist"
API=http://127.0.0.1:4319
[[ -d "$NEW" ]] || { echo "no build at $NEW"; exit 1; }
[[ ! -e "$RECORD" ]] || { echo "$BUILD is already installed ($RECORD)"; exit 1; }
codesign --verify --deep --strict '-R=identifier "com.babariviere.pilot-next"' "$NEW"
# A chat that only waits for a coding slot runs nothing; its queued input is durable and survives the restart.
working=$(curl -s -m3 "$API/api/sessions" | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(a.filter(s=>s.state==="working"||(s.working&&!s.codingQueueReason)).map(s=>s.title||s.id).join("; "))')
[[ -z "$working" ]] || { echo "chats working: $working"; exit 1; }
# A maintenance dark wake lasts at most about 3 minutes: installing in one lets the Mac sleep mid-quit.
woke=$(sysctl -n kern.waketime | awk -F'[ ,]+' '{print $4}')
(( $(date +%s) - woke >= 240 )) || { echo "just woke: try again once the Mac has been awake for 4 minutes"; exit 1; }
previous=$(defaults read "$APP/Contents/Info.plist" CFBundleVersion)
gui=$(pgrep -f "$APP/Contents/MacOS/pilot-desktop" || true)
if [[ -n "$gui" ]]; then
	osascript -e "tell application \"$APP\" to quit" || true # may print "User canceled (-128)" and still quit
	for _ in $(seq 1 60); do kill -0 "$gui" 2>/dev/null || break; sleep 0.5; done
	kill -0 "$gui" 2>/dev/null && { echo "GUI did not quit"; exit 1; }
fi
daemon=$(pgrep -f "$APP/Contents/Resources/runtime/packages/daemon/src/main.ts" || true)
launchctl bootout "$LABEL" || true
if [[ -n "$daemon" ]]; then
	for _ in $(seq 1 120); do kill -0 "$daemon" 2>/dev/null || break; sleep 0.5; done
	kill -0 "$daemon" 2>/dev/null && { echo "daemon did not stop"; exit 1; }
fi
for _ in $(seq 1 40); do pgrep -f "$APP/Contents/Resources/runtime" >/dev/null || break; sleep 0.5; done
pgrep -fl "$APP/Contents/Resources/runtime" && { echo "runtime processes remain"; exit 1; }
mkdir -p "$RECORD/retained"
chmod 700 "$RECORD"
mv "$APP" "$RECORD/retained/Pilot.app"
ditto "$NEW" "$APP"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for _ in $(seq 1 120); do curl -s -m2 "$API/api/hello" >/dev/null && break; sleep 0.5; done
pid=$(pgrep -f "$APP/Contents/Resources/runtime/packages/daemon/src/main.ts")
cat >"$RECORD/normal-update-complete.json" <<EOF
{"state":"ready","build":"$BUILD","previousBuild":"$previous","runtime":"$APP/Contents/Resources/runtime","pid":$pid,"previousApp":"$RECORD/retained/Pilot.app","time":"$(date -u +%FT%TZ)","policy":"Normal GUI quit, no working session. launchctl bootout, swap app, launchctl bootstrap. No handoff or rollback. Removes its build folder and older install records."}
EOF
open "$APP"
# The app now lives in ~/Applications: drop its build, and keep only this install's rollback copy.
rm -rf "${ROOT:?}/$BUILD"
for record in "$HOME"/Applications/Pilot-install-*; do
	[[ "$record" == "$RECORD" ]] || rm -rf "$record"
done
echo "INSTALLED $BUILD (previous $previous, daemon pid $pid)"
