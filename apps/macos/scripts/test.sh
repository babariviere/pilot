#!/usr/bin/env bash
# Command Line Tools ship Swift Testing's macro plugin outside the default plugin path.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# Hold the slot through package resolution, compilation and every test runner.
if [ "${PILOT_VERIFICATION_SWIFT_PID:-}" != "$$" ]; then
	exec python3 "$here/../../scripts/verification-slot.py" swift -- "$BASH" "$0" "$@"
fi
unset PILOT_VERIFICATION_SWIFT_PID
# shellcheck source=swift-env.sh
source "$here/scripts/swift-env.sh"
"$here/scripts/vendor-ghostty.sh"
"$here/scripts/share-artifacts.sh"
plugins="$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
# Multiple agents can verify concurrently. Avoid each one consuming every available CPU.
jobs=(--jobs "${PILOT_SWIFT_JOBS:-2}")
for argument in "$@"; do
	case "$argument" in --jobs|--jobs=*|-j|-j[0-9]*) jobs=();; esac
done
# CLT 27 can return 0 when an earlier test target failed and a later one passed.
# The output guard checks each started runner's terminal summary and recorded
# failures, not just SwiftPM's aggregate exit status. pipefail also preserves
# build failures, crashes and other nonzero driver exits.
# Bash 3.2 (macOS /bin/bash) treats an empty array as unset under nounset.
swift test --package-path "$here" ${jobs[@]+"${jobs[@]}"} -Xswiftc -plugin-path -Xswiftc "$plugins" "$@" 2>&1 \
	| python3 "$here/scripts/check-test-output.py"
