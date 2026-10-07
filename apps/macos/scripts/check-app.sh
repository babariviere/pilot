#!/usr/bin/env bash
# Smoke-test the signed app away from the checkout, including paths with spaces.
set -euo pipefail

[ "$#" -eq 1 ] || { echo "Usage: check-app.sh Pilot.app" >&2; exit 1; }
app="$(cd "$1" && pwd)"
[ -x "$app/Contents/MacOS/Pilot" ] || { echo "Missing executable: Contents/MacOS/Pilot" >&2; exit 1; }
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

scratch="$(mktemp -d "${TMPDIR:-/tmp}/pilot app check.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
trap 'exit 1' HUP INT TERM
moved="$scratch/Pilot.app"
ditto "$app" "$moved"
codesign --verify --deep --strict "$moved"
cd "$scratch"
python3 - "$moved/Contents/MacOS/Pilot" <<'PY'
import os
import subprocess
import sys

env = os.environ.copy()
env.pop("PACKAGE_RESOURCE_BUNDLE_PATH", None)
env.pop("PACKAGE_RESOURCE_BUNDLE_URL", None)
try:
    result = subprocess.run(
        [sys.argv[1], "--terminal-resource-test"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=30,
    )
except subprocess.TimeoutExpired as error:
    sys.stdout.buffer.write(error.output or b"")
    sys.stdout.flush()
    sys.exit("Terminal resource smoke test timed out after 30 seconds")
sys.stdout.buffer.write(result.stdout)
sys.stdout.flush()
if result.returncode != 0:
    sys.exit(f"Terminal resource smoke test failed (exit {result.returncode})")
PY
