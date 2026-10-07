#!/usr/bin/env bash
# Repackage the latest published stable app, without rebuilding or changing updates.
set -euo pipefail
unset GH_DEBUG
here="$(cd "$(dirname "$0")/.." && pwd)"
: "${GH_TOKEN:?Set GH_TOKEN for release asset publishing}"
: "${PILOT_UPDATE_REPOSITORY:?Set PILOT_UPDATE_REPOSITORY}"
stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-installer.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
# Resolve latest once. All subsequent operations use the captured tag, even if latest changes.
gh release view --repo "$PILOT_UPDATE_REPOSITORY" --json tagName,isDraft,isPrerelease,assets > "$stage/release.json"
tag="$(python3 "$here/scripts/release_metadata.py" dmg-release "$stage/release.json")"
gh release download "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --pattern Pilot-arm64.zip --dir "$stage"
ditto -x -k "$stage/Pilot-arm64.zip" "$stage/extracted"
app="$stage/extracted/Pilot.app"
python3 - "$app/Contents/Info.plist" "$tag" <<'PY'
import plistlib
import sys
with open(sys.argv[1], 'rb') as handle:
    info = plistlib.load(handle)
if f"v{info['CFBundleShortVersionString']}" != sys.argv[2]:
    raise SystemExit('Downloaded app version does not match the release tag')
PY
codesign --verify --deep --strict "$app"
dmg="$stage/Pilot-arm64.dmg"
bash "$here/scripts/create-dmg.sh" "$app" "$dmg"
# Published ZIP/appcast are immutable. Add only the optional installer, never overwrite it.
gh release upload "$tag" "$dmg" --repo "$PILOT_UPDATE_REPOSITORY"
