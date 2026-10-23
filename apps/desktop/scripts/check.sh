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
# Native production-root rounded geometry, motion, cancellation and cached-history checks.
bash scripts/cargo.sh clippy --locked --features native-probes --test style -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test style
# Actual SVG paint and mounted bounds, not just catalog names.
bash scripts/cargo.sh clippy --locked --features native-probes --test icons -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test icons
bash scripts/cargo.sh clippy --locked --features native-probes --test motion -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test motion
# Actual native gestures over a faux isolated-reader channel, never Local actions.
bash scripts/cargo.sh clippy --locked --features native-probes --test controls -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test controls
# Real top scroll/selection with faux paged reads, never a real Local action.
bash scripts/cargo.sh clippy --locked --features native-probes --test history -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test history
# Actual Home/projects/chat navigation with synthetic summaries/faux channels only.
bash scripts/cargo.sh clippy --locked --features native-probes --test shell -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test shell
# Bounded destination/scope state, fake read channel, no replay of actions.
bash scripts/cargo.sh clippy --locked --features native-probes --test navigation -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test navigation
# Read-only partial Inbox with native filtering, faux reads and no action replay.
bash scripts/cargo.sh clippy --locked --features native-probes --test inbox -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test inbox
# Ephemeral bounded resource palette, faux reads and no action replay.
bash scripts/cargo.sh clippy --locked --features native-probes --test jump -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test jump
# Same-fixture shell hierarchy and native chooser reachability/IME checks.
bash scripts/cargo.sh clippy --locked --features native-probes --test workbench -- -D warnings
env -u PILOT_NEXT_WORKBENCH_BASELINE bash scripts/cargo.sh test --locked --features native-probes --test workbench
