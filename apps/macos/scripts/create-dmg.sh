#!/usr/bin/env bash
# Drag-and-drop installer. The ZIP remains Sparkle's signed update archive.
set -euo pipefail
app="${1:?Usage: create-dmg.sh Pilot.app output.dmg}"
destination="${2:?Usage: create-dmg.sh Pilot.app output.dmg}"
[ -d "$app/Contents" ] || { echo "App bundle is missing: $app" >&2; exit 1; }
stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-dmg.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/content" "$(dirname "$destination")"
ditto "$app" "$stage/content/Pilot.app"
ln -s /Applications "$stage/content/Applications"
hdiutil create -volname Pilot -srcfolder "$stage/content" -format UDZO -fs HFS+ -ov "$destination"
hdiutil verify "$destination"
