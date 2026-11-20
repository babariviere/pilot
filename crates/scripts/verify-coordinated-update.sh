#!/usr/bin/env bash
# Private synthetic updater fixtures only. Never installs or starts the app/service.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/cargo.sh fmt --manifest-path updater/Cargo.toml -- --check
bash scripts/cargo.sh test --manifest-path updater/Cargo.toml --locked --features native-macos expected_targets_
bash scripts/cargo.sh test --manifest-path updater/Cargo.toml --locked --features native-macos local_signed_source_stages
