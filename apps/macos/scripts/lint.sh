#!/usr/bin/env bash
# A pinned, standalone lint gate. No package resolution or Swift build required.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
version=0.65.1
sha256=c1e429b0599cf1b516f369a2d9ec04eaf0e436f3c12b637df8851fa52ff694d0

swiftlint="${SWIFTLINT_BIN:-$(command -v swiftlint || true)}"
if [ -z "${SWIFTLINT_BIN:-}" ] && { [ -z "$swiftlint" ] || [ "$("$swiftlint" version)" != "$version" ]; }; then
	stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-swiftlint.XXXXXX")"
	trap 'rm -rf "$stage"' EXIT
	curl --fail --location --retry 3 \
		"https://github.com/realm/SwiftLint/releases/download/$version/portable_swiftlint.zip" \
		-o "$stage/swiftlint.zip"
	printf '%s  %s\n' "$sha256" "$stage/swiftlint.zip" | shasum -a 256 --check
	unzip -q "$stage/swiftlint.zip" -d "$stage/tool"
	swiftlint="$stage/tool/swiftlint"
fi
if [ "$("$swiftlint" version)" != "$version" ]; then
	echo "SwiftLint $version is required. Unset SWIFTLINT_BIN to download the pinned release." >&2
	exit 1
fi

cd "$here"
"$swiftlint" lint --config "$here/.swiftlint.yml" --strict --force-exclude --no-cache --quiet "$@"
