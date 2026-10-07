#!/usr/bin/env bash
# Regenerate the committed Resources/AppIcon.icns from Resources/AppIcon.svg after editing the SVG.
# Needs rsvg-convert (brew install librsvg). Usage: scripts/icon.sh [output.icns]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
svg="$here/Resources/AppIcon.svg"
out="${1:-$here/Resources/AppIcon.icns}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
iconset="$work/AppIcon.iconset"
mkdir -p "$iconset" "$(dirname "$out")"

for size in 16 32 128 256 512; do
	rsvg-convert -w "$size" -h "$size" "$svg" -o "$iconset/icon_${size}x${size}.png"
	rsvg-convert -w "$((size * 2))" -h "$((size * 2))" "$svg" -o "$iconset/icon_${size}x${size}@2x.png"
done
iconutil --convert icns --output "$out" "$iconset"
echo "$out"
