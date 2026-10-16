#!/usr/bin/env bash
# Release-build streaming benchmark: the offline --performance-check fixture streaming a long Markdown reply.
# Runs pilotd's real cadence (4 updates/s, larger chunks) and token-rate stress cases (10, 50, 100 deltas/s).
#
#   apps/macos/scripts/bench-streaming.sh            # build, then three runs of every case
#   PILOT_BENCH_RUNS=5 apps/macos/scripts/bench-streaming.sh --no-build
#
# It opens a window for about 20 s per run and never connects to the daemon. Compare branches on the same Mac,
# plugged in, with the window on the built-in display (120 Hz on ProMotion) and other apps idle.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" != "--no-build" ]; then "$here/scripts/build.sh" -c release >&2; fi
app="$here/.build/out/Products/Release/Pilot"
runs="${PILOT_BENCH_RUNS:-3}"
cases=("--rate 4 --chunk 100" "--rate 10" "--rate 50" "--rate 100")
for case in "${cases[@]}"; do
	for _ in $(seq "$runs"); do
		# shellcheck disable=SC2086 # Each case is a list of arguments.
		"$app" --performance-check --streaming --markdown $case
	done
done

