#!/usr/bin/env bash
# swift build for the macOS app, using an SDK where @State compiles (see swift-env.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${PILOT_VERIFICATION_SWIFT_PID:-}" != "$$" ]; then
	exec python3 "$here/../../scripts/verification-slot.py" swift -- "$BASH" "$0" "$@"
fi
unset PILOT_VERIFICATION_SWIFT_PID
# shellcheck source=swift-env.sh
source "$here/scripts/swift-env.sh"
"$here/scripts/vendor-ghostty.sh"
"$here/scripts/vendor-mermaidkit.sh"
"$here/scripts/vendor-quickjs.sh"
"$here/scripts/share-artifacts.sh"
jobs=(--jobs "${PILOT_SWIFT_JOBS:-2}")
for argument in "$@"; do
	case "$argument" in --jobs|--jobs=*|-j|-j[0-9]*) jobs=();; esac
done
exec swift build --package-path "$here" ${jobs[@]+"${jobs[@]}"} "$@"
