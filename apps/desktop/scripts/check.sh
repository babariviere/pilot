#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/prepare-visual-worker.py
bash scripts/cargo.sh build --locked -p pilot-visual-worker
bash scripts/cargo.sh fmt --all -- --check
bash scripts/cargo.sh clippy -p pilot-visual-worker --locked --all-targets -- -D warnings
bash scripts/cargo.sh clippy --all-targets --locked -- -D warnings
bash scripts/cargo.sh test --lib --locked -- --test-threads=1
# Native offscreen renderer, not a visible app or scrolling benchmark.
bash scripts/cargo.sh test --test rendering --locked
bash scripts/cargo.sh test --test chrome --locked
bash scripts/cargo.sh test --test visuals --locked
# Synthetic production-root multi-frame disclosure/activity regression only.
bash scripts/cargo.sh clippy --locked --features native-probes --test disclosure -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test disclosure
