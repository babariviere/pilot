#!/usr/bin/env bash
# Regenerate the committed Resources/AppIcon.svg, AppIconSmall.svg and AppIcon.icns from scripts/icon-svg.mjs.
# AppIconSmall.svg is the simplified drawing for 16 and 32 pt; AppIcon.svg covers 128 pt and up.
# Needs Node and rsvg-convert (brew install librsvg). Usage: scripts/icon.sh [output.icns]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
node "$here/scripts/icon-svg.mjs" >/dev/null
svg="$here/Resources/AppIcon.svg"
small="$here/Resources/AppIconSmall.svg"
out="${1:-$here/Resources/AppIcon.icns}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
iconset="$work/AppIcon.iconset"
mkdir -p "$iconset" "$(dirname "$out")"

for size in 16 32 128 256 512; do
	source="$svg"
	if [ "$size" -le 32 ]; then source="$small"; fi
	rsvg-convert -w "$size" -h "$size" "$source" -o "$iconset/icon_${size}x${size}.png"
	rsvg-convert -w "$((size * 2))" -h "$((size * 2))" "$source" -o "$iconset/icon_${size}x${size}@2x.png"
done
iconutil --convert icns --output "$out" "$iconset"
echo "$out"
