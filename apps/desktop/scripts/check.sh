#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/cargo.sh fmt -- --check
bash scripts/cargo.sh clippy --all-targets --locked -- -D warnings
bash scripts/cargo.sh test --lib --locked -- --test-threads=1
# Native offscreen renderer, not a visible app or scrolling benchmark.
bash scripts/cargo.sh test --test rendering --locked
bash scripts/cargo.sh test --test chrome --locked
