#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == "--local" ]]; then
 python3 scripts/prepare-visual-worker.py
 bash scripts/cargo.sh build --locked -p pilot-visual-worker
fi
exec bash scripts/cargo.sh run --locked -- "$@"
