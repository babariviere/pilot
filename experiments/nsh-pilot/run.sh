#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cargo build --locked -j 4
exec target/debug/pilot-nsh-workbench "$@"
