#!/usr/bin/env bash
# Vendor libghostty-spm at a pinned release so the app builds with Command Line Tools only.
# Upstream processes a .xcstrings catalog, which needs Xcode's xcstringstool; drop it (the
# wrapper falls back to its English keys, for example "Copy").
set -euo pipefail

version="2.2.2026100701"
here="$(cd "$(dirname "$0")/.." && pwd)"
target="$here/Vendor/libghostty-spm"

if [ ! -f "$target/.pilot-version" ] || [ "$(cat "$target/.pilot-version")" != "$version" ]; then
	rm -rf "$target"
	mkdir -p "$here/Vendor"
	git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$version" \
		https://github.com/Lakr233/libghostty-spm.git "$target"
	rm -rf "$target/.git" "$target/Example" "$target/Tests"
	# Drop the string catalog and the test target that referenced removed sources.
	perl -0pi -e 's/\s*\.process\("Resources\/Localizable\.xcstrings"\),//; s/\s*\.testTarget\(.*?\n        \),//s' "$target/Package.swift"
	rm -f "$target/Sources/GhosttyTerminal/Resources/Localizable.xcstrings"
	echo "$version" >"$target/.pilot-version"
fi

# Apply local patches even when the pinned checkout is already cached.
python3 "$here/scripts/patch-ghostty-resources.py" "$target"
