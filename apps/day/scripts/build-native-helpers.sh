#!/usr/bin/env bash
# Helper-only source closure. Never resolve/build the legacy Swift GUI package.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Day native helpers require arm64 macOS.' >&2; exit 1
fi
# Accept --day for callers that can also stage pre-cutover snapshots.
if [[ $# -lt 1 || $# -gt 2 || -e "$1" || -L "$1" || ( $# == 2 && "$2" != --day ) ]]; then
  echo 'Expected one fresh native-helper output directory.' >&2; exit 1
fi
target="$root/crates/power/target"
export CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 MACOSX_DEPLOYMENT_TARGET=15.0
# The snapshot requires a fixed output path, which the PATH fork ignores.
NSH_DAY_REAL_CARGO="$(rustup which --toolchain 1.99.1 cargo)"
RUSTC="$(rustup which --toolchain 1.99.1 rustc)"
export NSH_DAY_REAL_CARGO RUSTC
"$root/apps/day/scripts/cargo" build --locked --release --target-dir "$target" --manifest-path "$root/crates/power/Cargo.toml"
mkdir -p "$1"
cp "$target/release/PilotPower" "$1/PilotPower"
# Retained authenticated system-event accessory, not the Swift GUI.
/usr/bin/xcrun swiftc -O -warnings-as-errors -target arm64-apple-macosx15.0 \
  -framework AppKit -framework Network -framework IOKit -framework CoreGraphics \
  "$root/apps/day/macos/Sources/PilotSystemEvents/main.swift" \
  "$root/apps/day/macos/Sources/PilotSystemEvents/SystemPowerMonitor.swift" \
  -o "$1/PilotSystemEvents"
