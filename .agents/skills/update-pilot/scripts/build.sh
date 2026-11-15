#!/usr/bin/env bash
# Builds a production Pilot Day bundle from one commit of this checkout.
# Usage: build.sh [SOURCE_COMMIT] [BUILD]. Defaults: the jj working-copy commit and the next build number.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
ROOT="${PILOT_BUILD_ROOT:-/tmp/day-build}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/pilot-build"
APP="$HOME/Applications/Pilot.app"
RUST_TOOLCHAIN=1.99.1 # apps/day/README.md prerequisites

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

# Pinned QuickJS-NG source archive. The build never downloads it on its own.
QJS="$CACHE/quickjs-ng-0.17.0.tar.gz"
QJS_SHA=$(sed -n 's/^SHA = "\(.*\)"$/\1/p' apps/desktop/scripts/prepare-visual-worker.py)
mkdir -p "$CACHE"
if [[ ! -f "$QJS" ]]; then
	curl -fsSL -m 120 -o "$QJS.part" https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.17.0.tar.gz
	mv "$QJS.part" "$QJS"
fi
[[ "$(shasum -a 256 "$QJS" | cut -d' ' -f1)" == "$QJS_SHA" ]] || { echo "QuickJS-NG archive checksum mismatch: $QJS"; exit 1; }

# Missing tools stop the build here, before any work.
NSH_DAY_MBX=$(command -v mbx)
NSH_DAY_CLI=$(realpath "$(brew --prefix nsh)/libexec/bin/nsh")
NSH_DAY_REAL_CARGO=$(rustup which --toolchain "$RUST_TOOLCHAIN" cargo)
RUSTC=$(rustup which --toolchain "$RUST_TOOLCHAIN" rustc)
export NSH_DAY_CARGO_MODE=mbx NSH_DAY_MBX NSH_DAY_CLI NSH_DAY_REAL_CARGO RUSTC
export PILOT_DAY_QUICKJS_ARCHIVE="$QJS"
export PILOT_SIGNING_POLICY=private-adhoc
export PILOT_UPDATER_PUBLIC_KEY='MbGhgDgZuJPyC81SSCJ8IVEyLks66acK5s9NKIudSsE=' # docs/technical/day-package-inputs.md
export PILOT_UPDATER_REPOSITORY=babariviere/pilot
export PILOT_UPDATER_BUILD="$BUILD"

echo "SOURCE $SOURCE BUILD $BUILD"
work="$ROOT/$BUILD"
mkdir -p "$work"
[[ -d "$work/runtime" ]] || python3 apps/desktop/scripts/bundle_runtime.py runtime --source "$SOURCE" --output "$work/runtime"
[[ -d "$work/native" ]] || python3 apps/desktop/scripts/bundle_runtime.py native --gui day --source "$SOURCE" --output "$work/native"
rm -rf "$work/inputs" "$work/app"
python3 apps/desktop/scripts/day_build_inputs.py --production --source "$SOURCE" --output "$work/inputs"
mkdir "$work/app"
python3 apps/desktop/scripts/bundle_runtime.py bundle --production \
	--source "$SOURCE" --bundle-build "$BUILD" \
	--runtime "$work/runtime" --native "$work/native" --executables "$work/inputs" \
	--gui-resources "$work/inputs/nsh" --output "$work/app/Pilot.app"
python3 apps/desktop/scripts/bundle_runtime.py verify "$work/app/Pilot.app"
codesign --verify --deep --strict '-R=identifier "com.babariviere.pilot-next"' "$work/app/Pilot.app"
echo "BUILT $BUILD $work/app/Pilot.app"
