#!/usr/bin/env bash
# Builds a production Pilot Day bundle from one commit of this checkout.
# Usage: build.sh [SOURCE_COMMIT] [BUILD]. Defaults: the jj working-copy commit and the next build number.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
ROOT="${PILOT_BUILD_ROOT:-/tmp/day-build}"
APP="$HOME/Applications/Pilot.app"

next_build() {
	local today n=0 v
	today=$(date +%Y%m%d)
	for v in $(defaults read "$APP/Contents/Info.plist" CFBundleVersion 2>/dev/null) $(ls "$ROOT" 2>/dev/null); do
		if [[ "$v" =~ ^$today\.([0-9]+)$ ]] && ((BASH_REMATCH[1] > n)); then n=${BASH_REMATCH[1]}; fi
	done
	echo "$today.$((n + 1))"
}

SOURCE="${1:-$(jj log -r @ --no-graph -T commit_id)}"
BUILD="${2:-$(next_build)}"
[[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || { echo "source must be a full commit id"; exit 1; }
# The production Day build recipe starts here.
git merge-base --is-ancestor 29102eb5f20f735c208300769f65cd9227279986 "$SOURCE"

# Missing tools stop the build here, before any work.
NSH_DAY_CLI=$(realpath "$(brew --prefix nsh)/libexec/bin/nsh")
unset NSH_DAY_REAL_CARGO RUSTC
export NSH_DAY_CLI
export PILOT_SIGNING_POLICY=private-adhoc
export PILOT_UPDATER_PUBLIC_KEY='MbGhgDgZuJPyC81SSCJ8IVEyLks66acK5s9NKIudSsE=' # docs/technical/day-package-inputs.md
export PILOT_UPDATER_REPOSITORY=babariviere/pilot
export PILOT_UPDATER_BUILD="$BUILD"

echo "SOURCE $SOURCE BUILD $BUILD"
work="$ROOT/$BUILD"
# A build is about 1 GB here. Builds at or below the installed one are spent: remove them first.
installed=$(defaults read "$APP/Contents/Info.plist" CFBundleVersion 2>/dev/null || true)
if [[ -n "$installed" ]]; then
	for dir in "$ROOT"/*; do
		old=$(basename "$dir")
		[[ -d "$dir" && "$old" =~ ^[0-9]{8}\.[0-9]+$ && "$old" != "$BUILD" ]] || continue
		if [[ "$(printf '%s\n%s\n' "$old" "$installed" | sort -V | tail -1)" == "$installed" ]]; then rm -rf "${dir:?}"; fi
	done
fi
# A failed or stopped build leaves nothing behind.
built=0
trap '[[ $built == 1 ]] || rm -rf "${work:?}"' EXIT
trap 'exit 143' TERM INT
mkdir -p "$work"
echo 'STAGE runtime'
[[ -d "$work/runtime" ]] || python3 apps/day/scripts/bundle_runtime.py runtime --source "$SOURCE" --output "$work/runtime"
echo 'STAGE native helpers'
[[ -d "$work/native" ]] || python3 apps/day/scripts/bundle_runtime.py native --gui day --source "$SOURCE" --output "$work/native"
rm -rf "$work/inputs" "$work/app"
echo 'STAGE desktop, updater, artifact host and NSH resources'
python3 apps/day/scripts/day_build_inputs.py --production --source "$SOURCE" --output "$work/inputs"
mkdir "$work/app"
echo 'STAGE bundle assembly and verification'
python3 apps/day/scripts/bundle_runtime.py bundle --production \
	--source "$SOURCE" --bundle-build "$BUILD" \
	--runtime "$work/runtime" --native "$work/native" --executables "$work/inputs" \
	--gui-resources "$work/inputs/nsh" --output "$work/app/Pilot.app"
python3 apps/day/scripts/bundle_runtime.py verify "$work/app/Pilot.app"
codesign --verify --deep --strict '-R=identifier "com.babariviere.pilot-next"' "$work/app/Pilot.app"
built=1
echo "BUILT $BUILD $work/app/Pilot.app"
