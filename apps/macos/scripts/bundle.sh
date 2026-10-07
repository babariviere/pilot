#!/usr/bin/env bash
# Build Pilot.app. BUNDLE_RUNTIME=1 produces a self-contained Apple Silicon release.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
configuration="${CONFIGURATION:-release}"
app="$here/build/Pilot.app"
runtime="${BUNDLE_RUNTIME:-0}"
[ "$runtime" = 0 ] || [ "$runtime" = 1 ] || { echo "BUNDLE_RUNTIME must be 0 or 1" >&2; exit 1; }
if [ "$runtime" = 1 ]; then
	[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
		echo "Release bundles require arm64 macOS" >&2; exit 1;
	}
	: "${BUNDLE_VERSION:?Set BUNDLE_VERSION to a numeric monotonic build version}"
	: "${PILOT_UPDATE_REPOSITORY:?Set PILOT_UPDATE_REPOSITORY to owner/repo}"
	: "${SPARKLE_PUBLIC_KEY:?Set SPARKLE_PUBLIC_KEY to the Sparkle public key}"
fi

"$here/scripts/vendor-ghostty.sh"
swift build --package-path "$here" -c "$configuration" --product Pilot \
	-Xswiftc -file-prefix-map -Xswiftc "$repo=/pilot" \
	-Xswiftc -debug-prefix-map -Xswiftc "$repo=/pilot"
bin="$(swift build --package-path "$here" -c "$configuration" --show-bin-path)"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"
cp "$bin/Pilot" "$app/Contents/MacOS/Pilot"
# SwiftPM resource bundles (libghostty runtime resources: terminfo, shell integration).
for bundle in "$bin"/*.bundle; do
	[ -e "$bundle" ] && cp -R "$bundle" "$app/Contents/Resources/"
done
framework="$bin/Sparkle.framework"
if [ ! -d "$framework" ]; then
	framework="$(find "$here/.build/artifacts" -type d -name Sparkle.framework -print -quit)"
fi
[ -d "$framework" ] || { echo "Sparkle.framework missing. Resolve Sparkle 2.8.1 through SwiftPM." >&2; exit 1; }
ditto "$framework" "$app/Contents/Frameworks/Sparkle.framework"
if [ "$runtime" = 1 ]; then
	python3 "$here/scripts/release_metadata.py" plist "$here/Resources/Info.plist" \
		"$app/Contents/Info.plist" "$repo" --release
else
	python3 "$here/scripts/release_metadata.py" plist "$here/Resources/Info.plist" \
		"$app/Contents/Info.plist" "$repo"
fi
cp "$here/Resources/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"

if [ "$runtime" = 1 ]; then
	"$here/scripts/bundle-runtime.sh" "$app/Contents/Resources/runtime"
	# SwiftPM adds checkout-local runpaths for unbundled launches. They are never needed here.
	while IFS= read -r path; do
		case "$path" in
			/*) install_name_tool -delete_rpath "$path" "$app/Contents/MacOS/Pilot" ;;
		esac
	done < <(otool -l "$app/Contents/MacOS/Pilot" | awk '/cmd LC_RPATH/{r=1;next} r && /path /{print $2;r=0}')
	strip -S "$app/Contents/MacOS/Pilot"
	# Code in Resources is not automatically visited by codesign --deep.
	while IFS= read -r -d '' binary; do
		if file "$binary" | grep -q 'Mach-O'; then
			codesign --force --sign - "$binary"
		fi
	done < <(find "$app/Contents/Resources/runtime" -type f \( -name '*.node' -o -name '*.dylib' -o -perm -111 \) -print0)
fi

codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
echo "$app"
