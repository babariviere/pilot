#!/usr/bin/env bash
# Vendor MermaidKit at a pinned release with Pilot's patches (scripts/patches/mermaidkit-*.patch).
# Patches fix parser gaps that matter for chat diagrams; send each upstream and drop it once released.
set -euo pipefail

version="v2.4.0"
here="$(cd "$(dirname "$0")/.." && pwd)"
target="$here/Vendor/MermaidKit"
patches=("$here"/scripts/patches/mermaidkit-*.patch)
stamp="$version $(cat "${patches[@]}" | shasum -a 256 | cut -d' ' -f1)"

if [ ! -f "$target/.pilot-version" ] || [ "$(cat "$target/.pilot-version")" != "$stamp" ]; then
	rm -rf "$target"
	mkdir -p "$here/Vendor"
	git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$version" \
		https://github.com/2389-research/MermaidKit.git "$target"
	# Keep the Swift package only (its test targets stay declared, so Tests stays): no other platform
	# ports, docs or images.
	rm -rf "$target/.git" "$target/android" "$target/flutter" "$target/windows" "$target/docs" "$target/assets" \
		"$target/scratchpad" "$target/tools"
	for patch in "${patches[@]}"; do
		patch --quiet --forward -p1 -d "$target" -i "$patch"
	done
	echo "$stamp" >"$target/.pilot-version"
fi
