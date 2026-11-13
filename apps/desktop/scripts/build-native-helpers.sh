#!/usr/bin/env bash
# Helper-only source closure. Never resolve/build the legacy Swift GUI package.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Next native helpers require arm64 macOS.' >&2; exit 1
fi
if [[ $# -lt 1 || $# -gt 2 || -e "$1" || -L "$1" || ( $# == 2 && "$2" != --day ) ]]; then
  echo 'Expected one fresh native-helper output directory.' >&2; exit 1
fi
if [[ "${2:-}" == --day ]]; then
  # Day uses its supported MBX dispatcher and installed global toolchain.
  export CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 MACOSX_DEPLOYMENT_TARGET=15.0
  "$root/apps/day/scripts/cargo" build --locked --release --manifest-path "$root/apps/power/Cargo.toml"
else
  bash "$root/apps/power/scripts/cargo.sh" build --locked --release
fi
mkdir -p "$1"
cp "$root/apps/power/target/release/PilotPower" "$1/PilotPower"
# Retained authenticated system-event accessory, not the Swift GUI.
/usr/bin/xcrun swiftc -O -warnings-as-errors -target arm64-apple-macosx15.0 \
  -framework AppKit -framework Network -framework IOKit -framework CoreGraphics \
  "$root/apps/macos/Sources/PilotSystemEvents/main.swift" \
  "$root/apps/macos/Sources/PilotSystemEvents/SystemPowerMonitor.swift" \
  -o "$1/PilotSystemEvents"
