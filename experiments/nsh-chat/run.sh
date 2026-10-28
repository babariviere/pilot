#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
backend="${1:-nsh}"
[[ $# == 0 ]] || shift
case "$backend" in
  nsh) cargo build --locked -j 4; binary="$PWD/target/debug/nsh-chat-prototype" ;;
  gpui)
    root="$(cd ../.. && pwd)"
    [[ -x "$root/apps/desktop/.tools/bin/mbx" ]] || bash "$root/apps/desktop/scripts/bootstrap.sh"
    python3 "$root/apps/desktop/scripts/prepare-patches.py"
    export RUSTUP_HOME="$root/apps/desktop/.tools/rustup" RUSTUP_TOOLCHAIN=1.98.1
    export CARGO_TARGET_DIR="$PWD/gpui/target" CARGO_BUILD_JOBS=2 MACOSX_DEPLOYMENT_TARGET=15.0
    export MBX_CACHE_DIR="$HOME/.cache/gpui-fixture-mbx-v1" MBX_TARGET_VIEWS=0
    "$root/apps/desktop/.tools/bin/mbx" build --locked --manifest-path gpui/Cargo.toml
    binary="$PWD/gpui/target/debug/chat-gpui-comparison" ;;
  *) echo 'Usage: bash experiments/nsh-chat/run.sh [nsh|gpui] [--probe]' >&2; exit 2 ;;
esac
# Automation stays hidden. --visible is only for a separately approved run.
for arg in "$@"; do
  if [[ "$arg" == --probe || "$arg" == --bench || "$arg" == --checks ]]; then
    exec "$binary" "$@"
  fi
done
app="$PWD/output/Chat-$backend.app"
mkdir -p "$app/Contents/MacOS"
cp Info.plist "$app/Contents/Info.plist"
ln -sf "$binary" "$app/Contents/MacOS/chat"
/usr/bin/open -n -W --stdout "$PWD/output/$backend-stdout.log" --stderr "$PWD/output/$backend-stderr.log" "$app" --args "$@"
