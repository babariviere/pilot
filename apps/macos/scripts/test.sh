#!/usr/bin/env bash
# Command Line Tools ship Swift Testing's macro plugin outside the default plugin path.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# Hold the slot through package resolution, compilation and every test runner.
if [ "${PILOT_VERIFICATION_SWIFT_PID:-}" != "$$" ]; then
	exec python3 "$here/../../scripts/verification-slot.py" swift -- "$BASH" "$0" "$@"
fi
unset PILOT_VERIFICATION_SWIFT_PID
# Chrome text stays on the Theme.TextRole scale; fails fast on new fixed font sizes or text styles.
python3 "$here/scripts/check-font-roles.py"
# shellcheck source=swift-env.sh
source "$here/scripts/swift-env.sh"
"$here/scripts/vendor-ghostty.sh"
"$here/scripts/vendor-mermaidkit.sh"
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
# Native window interaction and this WebKit matrix must not compete with hundreds
# of unrelated MainActor tests and their nested AppKit run loops. Keep their
# assertions and time limits, running each in its own process with the same build.
isolated=artifactHeightRespectsNestedClippingWhileKeepingVisibleOverflow
devbox=addDevboxPresentsSetupSheetAfterCancelAndReopen
terminal=terminalOpeningAndResizingDoNotFeedNativeFittingSizeBackIntoWindowConstraints
callbacks='localStopNormalizesQualifiedRowsAndRestoresWithdrawnMessages|remoteStopKeepsCollidingLocalChatAndDraftUntouched|unavailableStopNeverFallsBackToCurrentLocalHost|missionTaskDragLoadsItsPlainTextOnTheMainActor'
partition=1
reuse=(--skip-build)
for argument in "$@"; do
	case "$argument" in
		--skip-build) reuse=() ;;
		--filter|--filter=*|--skip|--skip=*|--list-tests|--list-tests=*|-l|list|--version|--help|-h|--show-codecov-path)
			partition=0 ;;
	esac
done
run_tests() {
	local required="$1"
	shift
	local guards=()
	local required_tests=()
	local name
	if [ -n "$required" ]; then
		IFS='|' read -r -a required_tests <<< "$required"
		for name in "${required_tests[@]}"; do guards+=(--require-test "$name"); done
	fi
	swift test --package-path "$here" ${jobs[@]+"${jobs[@]}"} -Xswiftc -plugin-path -Xswiftc "$plugins" "$@" 2>&1 \
		| python3 "$here/scripts/check-test-output.py" ${guards[@]+"${guards[@]}"}
}
if [ "$partition" = 1 ]; then
	run_tests "" "$@" --skip "$isolated|$devbox|$terminal|$callbacks"
	run_tests "$isolated" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$isolated"
	run_tests "$devbox" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$devbox"
	run_tests "$terminal" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$terminal"
	# Stop and drag-data callbacks keep their MainActor deadlines without competing with UI run loops.
	run_tests "$callbacks" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$callbacks"
else
	# Explicit selection/listing is the caller's scope. Do not append another filter.
	run_tests "" "$@"
fi
