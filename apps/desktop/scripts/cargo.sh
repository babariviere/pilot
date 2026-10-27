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
# Ambient mbx configuration must not change verification or release compilers.
export MBX_BLAZE=0
if [[ "${1:-}" == --blaze ]]; then
  shift
  if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ]]; then
    echo 'Blaze is local development only, not CI.' >&2; exit 1
  fi
  case "${1:-}" in
    build|b|run|r|test|t|check|c|status|stop) ;;
    *) echo 'Blaze requires a dev build/run/test/check (or status/stop).' >&2; exit 1 ;;
  esac
  for argument in "$@"; do
    [[ "$argument" != -- ]] || break
    case "$argument" in
      --release|-r|--profile|--profile=*)
        echo 'Use the ordinary cargo.sh path for release/named profiles.' >&2; exit 1 ;;
    esac
  done
  if [[ ! -x .tools/blaze/shim/cargo || ! -x .tools/blaze/bin/ra-jit ]]; then
    echo 'Run bash scripts/bootstrap.sh --blaze first.' >&2; exit 1
  fi
  export RUSTUP_TOOLCHAIN=1.99.0
  export CARGO_TARGET_DIR="$PWD/target/blaze"
  CARGO="$(rustup which --toolchain 1.99.0 cargo)"
  export CARGO
  export PATH="$PWD/.tools/blaze/bin:$PATH"
  # Short, worktree-specific sockets, never the user's shared ra-jit daemon.
  key="$(python3 -c 'import hashlib, os; print(hashlib.sha256(os.getcwd().encode()).hexdigest()[:16])')"
  export RA_JIT_HOME="$HOME/.cache/pb/$key"
  export RA_JIT_SPARE=0 RA_JIT_CACHE=off
  if [[ "$1" == status || "$1" == stop ]]; then
    exec .tools/blaze/bin/ra-jit "$@"
  fi
  python3 scripts/prepare-patches.py
  export MBX_BLAZE=1
  # No verification-slot queue. This lease covers both Blaze and nested Cargo.
  # mbx1.28 migrates incremental metadata. Keep it away from pinned1.26 state,
  # but acquire the existing shared scheduler before entering its shared store.
  exec .tools/blaze/bin/mbx reserve --cpus 2 --memory 4GiB -- \
    env MBX_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/gpui-fixture-blaze-mbx-v1" \
    "$PWD/.tools/blaze/shim/cargo" "$@"
fi
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  # Runners start empty and never share an mbx store, so mbx cannot hit there.
  # Same toolchain, target and job bound; tests.yaml caches dependency outputs.
  export CARGO_INCREMENTAL=0
  python3 scripts/prepare-patches.py
  exec cargo "$@"
fi
if [[ ! -x .tools/bin/mbx ]]; then
  echo 'Run bash scripts/bootstrap.sh first.' >&2; exit 1
fi
python3 scripts/prepare-patches.py
exec .tools/bin/mbx "$@"
