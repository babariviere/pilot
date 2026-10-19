#!/usr/bin/env bash
# Smoke-test the signed app away from the checkout, including paths with spaces.
set -euo pipefail

[ "$#" -eq 1 ] || { echo "Usage: check-app.sh Pilot.app" >&2; exit 1; }
app="$(cd "$1" && pwd)"
[ -x "$app/Contents/MacOS/Pilot" ] || { echo "Missing executable: Contents/MacOS/Pilot" >&2; exit 1; }
[ -x "$app/Contents/Helpers/PilotPower" ] || { echo "Missing executable: Contents/Helpers/PilotPower" >&2; exit 1; }
visuals="$app/Contents/XPCServices/PilotVisuals.xpc"
[ -x "$visuals/Contents/MacOS/PilotVisuals" ] || { echo "Missing XPC service: $visuals" >&2; exit 1; }
# The visual service runs agent-written scripts: the App Sandbox must be its only entitlement.
codesign -d --entitlements - --xml "$visuals" 2>/dev/null | python3 -c '
import plistlib, sys
entitlements = plistlib.loads(sys.stdin.buffer.read() or b"<plist><dict/></plist>")
if entitlements != {"com.apple.security.app-sandbox": True}:
    sys.exit(f"PilotVisuals.xpc must have only the App Sandbox entitlement, has {entitlements}")
'
bundle="$app/Contents/Resources/GhosttyKit_GhosttyTerminal.bundle"
[ -d "$bundle" ] || { echo "Missing resource bundle: $bundle" >&2; exit 1; }
# SwiftPM supports both flat bundles and macOS Contents/Resources bundles.
resources="$bundle"
if [ -d "$bundle/Contents/Resources" ]; then
	resources="$bundle/Contents/Resources"
fi
for resource in Ghostty terminfo; do
	[ -d "$resources/$resource" ] || { echo "Missing resource directory: $resources/$resource" >&2; exit 1; }
done

core="$app/Contents/Resources/PilotMac_PilotCore.bundle"
[ -d "$core" ] || { echo "Missing resource bundle: $core" >&2; exit 1; }
core_resources="$core"
if [ -d "$core/Contents/Resources" ]; then
	core_resources="$core/Contents/Resources"
fi
[ -f "$core_resources/LinuxSSHBootstrap.py" ] || {
	echo "Missing resource file: $core_resources/LinuxSSHBootstrap.py" >&2; exit 1;
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/pilot app check.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
trap 'exit 1' HUP INT TERM
moved="$scratch/Pilot.app"
ditto "$app" "$moved"
codesign --verify --deep --strict "$moved"
cd "$scratch"
for check in --terminal-resource-test --visuals-check; do
python3 - "$moved/Contents/MacOS/Pilot" "$check" <<'PY'
import os
import subprocess
import sys

check = sys.argv[2]
env = os.environ.copy()
env.pop("PACKAGE_RESOURCE_BUNDLE_PATH", None)
env.pop("PACKAGE_RESOURCE_BUNDLE_URL", None)
try:
    result = subprocess.run(
        [sys.argv[1], check],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=30,
    )
except subprocess.TimeoutExpired as error:
    sys.stdout.buffer.write(error.output or b"")
    sys.stdout.flush()
    sys.exit(f"{check} smoke test timed out after 30 seconds")
sys.stdout.buffer.write(result.stdout)
sys.stdout.flush()
if result.returncode != 0:
    sys.exit(f"{check} smoke test failed (exit {result.returncode})")
PY
done
