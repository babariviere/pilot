#!/usr/bin/env bash
# swift build for the macOS app, using an SDK where @State compiles (see swift-env.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=swift-env.sh
source "$here/scripts/swift-env.sh"
"$here/scripts/vendor-ghostty.sh"
"$here/scripts/share-artifacts.sh"
jobs=(--jobs "${PILOT_SWIFT_JOBS:-2}")
for argument in "$@"; do
	case "$argument" in --jobs|--jobs=*|-j|-j[0-9]*) jobs=();; esac
done
exec swift build --package-path "$here" "${jobs[@]}" "$@"
