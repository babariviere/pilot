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
export CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 MACOSX_DEPLOYMENT_TARGET=15.0
power=$(cd "$root/apps/day" && ./scripts/cargo build --locked --release --bin PilotPower \
  --manifest-path "$root/crates/power/Cargo.toml" --message-format=json-render-diagnostics | node --input-type=module -e '
import { readFileSync } from "node:fs";
const paths = readFileSync(0, "utf8").split("\n").flatMap((line) => {
  if (!line.startsWith("{")) return [];
  const m = JSON.parse(line);
  return m.reason === "compiler-artifact" && m.target.name === "PilotPower" && m.executable ? [m.executable] : [];
});
if (paths.length !== 1) throw new Error("Expected one Cargo executable artifact for PilotPower");
console.log(paths[0]);
')
mkdir -p "$1"
cp "$power" "$1/PilotPower"
# Retained authenticated system-event accessory, not the Swift GUI.
/usr/bin/xcrun swiftc -O -warnings-as-errors -target arm64-apple-macosx15.0 \
  -framework AppKit -framework Network -framework IOKit -framework CoreGraphics \
  "$root/apps/day/macos/Sources/PilotSystemEvents/main.swift" \
  "$root/apps/day/macos/Sources/PilotSystemEvents/SystemPowerMonitor.swift" \
  -o "$1/PilotSystemEvents"
