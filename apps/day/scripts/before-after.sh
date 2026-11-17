#!/usr/bin/env bash
# Real Day captures of one change: Before at the parent revision, After at the revision.
# Runs the same capture test (from After) in two temporary jj workspaces with the macOS host, then
# copies the PNGs it writes to output/ into <out>/before and <out>/after. Fixture data only.
set -euo pipefail
# jj revisions such as @ belong to the workspace this script is in.
cd "$(dirname "$0")/../../.."

usage() {
	cat >&2 <<'EOF'
Usage: apps/day/scripts/before-after.sh [-r REV] [--before REV] [--filter NAME] [--out DIR] TEST_FILE
  TEST_FILE      capture test, relative to apps/day (for example Native.test.tsx)
  -r REV         After revision (default @)
  --before REV   Before revision (default: the parent of REV)
  --filter NAME  run only tests whose name contains NAME
  --out DIR      where to put before/ and after/ (default: a new directory under TMPDIR)
EOF
	exit 2
}

after_rev=@ before_rev='' filter='' out='' test_file=''
while [[ $# -gt 0 ]]; do
	case "$1" in
		-r) after_rev="${2:?}"; shift 2 ;;
		--before) before_rev="${2:?}"; shift 2 ;;
		--filter) filter="${2:?}"; shift 2 ;;
		--out) out="${2:?}"; shift 2 ;;
		-*) usage ;;
		*) [[ -z "$test_file" ]] || usage; test_file="$1"; shift ;;
	esac
done
[[ -n "$test_file" ]] || usage
before_rev="${before_rev:-($after_rev)-}"

commit() {
	local ids
	ids="$(jj log --no-graph -r "$1" -T 'commit_id ++ "\n"')"
	if [[ "$(printf '%s\n' "$ids" | grep -c .)" != 1 ]]; then
		echo "before-after: '$1' must name exactly one revision" >&2
		exit 2
	fi
	printf '%s' "$ids"
}
after="$(commit "$after_rev")"
before="$(commit "$before_rev")"

out="${out:-$(mktemp -d "${TMPDIR:-/tmp}/pilot-before-after.XXXXXX")}"
mkdir -p "$out/before" "$out/after"
work="$(mktemp -d "${TMPDIR:-/tmp}/pilot-before-after-work.XXXXXX")"
names=()
cleanup() {
	for name in ${names[@]+"${names[@]}"}; do jj workspace forget "$name" >/dev/null 2>&1 || true; done
	rm -rf "$work"
}
trap cleanup EXIT

checkout() { # side commit
	local name="before-after-$1-$$"
	names+=("$name")
	jj workspace add --quiet --name "$name" -r "$2" "$work/$1" >/dev/null
}

capture() { # side
	local day="$work/$1/apps/day"
	local args=(test "$test_file" --target macos)
	[[ -z "$filter" ]] || args+=(--filter "$filter")
	echo "before-after: capturing $1" >&2
	local status=0
	(cd "$day" && rm -rf output && ./nsh.sh "${args[@]}") || status=$?
	# Keep what a failed run did write: a later step may need code this revision lacks.
	[[ -d "$day/output" ]] || return 1
	find "$day/output" -maxdepth 1 -name '*.png' -exec cp {} "$out/$1/" \;
	return "$status"
}

checkout after "$after"
[[ -f "$work/after/apps/day/$test_file" ]] || { echo "before-after: no apps/day/$test_file at $after_rev" >&2; exit 2; }
checkout before "$before"
# The same capture steps on both sides, so a new or changed test still compares like with like.
cp "$work/after/apps/day/$test_file" "$work/before/apps/day/$test_file"

capture after
before_ok=1
capture before || before_ok=0

echo "Before: $before"
echo "After:  $after"
found=0
for png in "$out/after"/*.png; do
	[[ -e "$png" ]] || continue
	found=1
	file="$(basename "$png")"
	if [[ -f "$out/before/$file" ]]; then echo "pair  $out/before/$file  $png"; else echo "new   $png"; fi
done
[[ "$found" == 1 ]] || { echo "before-after: the test wrote no PNG to output/" >&2; exit 1; }
[[ "$before_ok" == 1 ]] || echo "before-after: the Before run failed; captures without a pair have no Before" >&2
