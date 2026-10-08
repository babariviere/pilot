#!/usr/bin/env bash
# Command Line Tools ship Swift Testing's macro plugin outside the default plugin path.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
"$here/scripts/vendor-ghostty.sh"
plugins="$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
# Multiple agents can verify concurrently. Avoid each one consuming every available CPU.
jobs=(--jobs "${PILOT_SWIFT_JOBS:-2}")
for argument in "$@"; do
	case "$argument" in --jobs|--jobs=*|-j|-j[0-9]*) jobs=();; esac
done
exec swift test --package-path "$here" "${jobs[@]}" -Xswiftc -plugin-path -Xswiftc "$plugins" "$@"
