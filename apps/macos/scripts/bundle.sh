#!/usr/bin/env bash
# Build Pilot.app: the Swift app, SwiftPM resource bundles, ad-hoc signature.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
configuration="${CONFIGURATION:-release}"
app="$here/build/Pilot.app"

"$here/scripts/vendor-ghostty.sh"
swift build --package-path "$here" -c "$configuration" --product Pilot
bin="$(swift build --package-path "$here" -c "$configuration" --show-bin-path)"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/Pilot" "$app/Contents/MacOS/Pilot"
# SwiftPM resource bundles (libghostty runtime resources: terminfo, shell integration).
for bundle in "$bin"/*.bundle; do
	[ -e "$bundle" ] && cp -R "$bundle" "$app/Contents/Resources/"
done
plutil -replace PilotRepoPath -string "$repo" -o "$app/Contents/Info.plist" "$here/Resources/Info.plist"

codesign --force --deep --sign - "$app"
echo "$app"
