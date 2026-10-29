#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
desktop="$PWD/../desktop"
export RUSTUP_HOME="$desktop/.tools/rustup" RUSTUP_TOOLCHAIN=1.98.1
export PATH="$desktop/.tools/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$PWD/target" CARGO_BUILD_JOBS=2 MACOSX_DEPLOYMENT_TARGET=15.0
export MBX_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/gpui-fixture-mbx-v1"
export MBX_SCHEDULER=1 MBX_SCHEDULER_CPUS=2 MBX_SCHEDULER_MEMORY=4GiB
export MBX_GC_MAX_SIZE=2GiB MBX_GC_MIN_FREE_SIZE=4GiB MBX_REMOTE_URL="" MBX_TARGET_VIEWS=0 MBX_BLAZE=0
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  export CARGO_INCREMENTAL=0
  exec cargo "$@"
fi
if [[ ! -x "$desktop/.tools/bin/mbx" ]]; then
  echo 'Bootstrap apps/desktop pinned Rust/mbx tools first.' >&2; exit 1
fi
exec "$desktop/.tools/bin/mbx" "$@"
