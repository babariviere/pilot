#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTUP_HOME="$PWD/.tools/rustup"
export RUSTUP_TOOLCHAIN=1.98.1
export CARGO_TARGET_DIR="$PWD/target/dev"
export CARGO_BUILD_JOBS=2
export MACOSX_DEPLOYMENT_TARGET=15.0
# Separate from production state. Eligible outputs and scheduler are shared across
# fixture worktrees. Never share Cargo target/incremental directories.
export MBX_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/gpui-fixture-mbx-v1"
export MBX_SCHEDULER=1 MBX_SCHEDULER_CPUS=2 MBX_SCHEDULER_MEMORY=4GiB
export MBX_GC_MAX_SIZE=2GiB MBX_REMOTE_URL=""
export MBX_GC_MIN_FREE_SIZE=4GiB
export MBX_TARGET_VIEWS=0
export PATH="$PWD/.tools/bin:$HOME/.cargo/bin:$PATH"
if [[ ! -x .tools/bin/mbx ]]; then
  echo 'Run bash scripts/bootstrap.sh first.' >&2; exit 1
fi
python3 scripts/prepare-patches.py
exec .tools/bin/mbx "$@"
