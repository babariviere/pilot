#!/usr/bin/env bash
# Native-only chart fixtures. The former HTML/ECharts comparison is retired.
# Opens a visible synthetic window; run only with explicit benchmark approval.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
if [ "${1:-}" != "--no-build" ]; then CONFIGURATION=release "$here/scripts/bundle.sh" >&2; fi
app="$here/build/Pilot.app/Contents/MacOS/Pilot"
runs="${PILOT_BENCH_RUNS:-3}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
node "$repo/scripts/bench/visual-artifacts.ts" "$work/fixture.json" >&2
caffeinate -u -t 1 >/dev/null
for _ in $(seq "$runs"); do
	for kind in visual; do
		caffeinate -dimsu "$app" --visual-artifact-bench "$work/fixture.json" --kind "$kind" | tee -a "$work/results.jsonl"
		sleep 2
	done
done
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter((line) => line.startsWith("{"));
const runs = lines.map((line) => JSON.parse(line));
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
for (const kind of ["visual"]) {
	const mine = runs.filter((run) => run.kind === kind);
	if (!mine.length) continue;
	const keys = Object.keys(mine[0]).filter((key) => typeof mine[0][key] === "number");
	console.log(kind + " (median of " + mine.length + "): " + keys.map((key) => key + "=" + median(mine.map((run) => run[key]))).join(" "));
}' "$work/results.jsonl"
