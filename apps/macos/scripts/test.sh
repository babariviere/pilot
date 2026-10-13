#!/usr/bin/env bash
# Command Line Tools ship Swift Testing's macro plugin outside the default plugin path.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=swift-env.sh
source "$here/scripts/swift-env.sh"
"$here/scripts/vendor-ghostty.sh"
plugins="$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
# Multiple agents can verify concurrently. Avoid each one consuming every available CPU.
jobs=(--jobs "${PILOT_SWIFT_JOBS:-2}")
for argument in "$@"; do
	case "$argument" in --jobs|--jobs=*|-j|-j[0-9]*) jobs=();; esac
done
# CLT 27 can return 0 when an earlier test target failed and a later one passed.
# Inspect every runner summary, not just SwiftPM's aggregate exit status. pipefail
# also preserves build failures, crashes and other nonzero driver exits.
swift test --package-path "$here" "${jobs[@]}" -Xswiftc -plugin-path -Xswiftc "$plugins" "$@" 2>&1 \
	| python3 "$here/scripts/check-test-output.py"
