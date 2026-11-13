#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTUP_HOME="$PWD/.tools/rustup"
export RUSTUP_TOOLCHAIN=1.98.1
export CARGO_TARGET_DIR="$PWD/target/dev"
export MACOSX_DEPLOYMENT_TARGET=15.0
# Resolve before adding checkout tools, which may contain an obsolete mbx.
mbx="$(command -v mbx || true)"
export PATH="$PWD/.tools/bin:$HOME/.cargo/bin:$PATH"
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
  if [[ ! -x .tools/blaze/bin/ra-jit ]]; then
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
  # Keep experimental outputs separate; use the mise-managed Cargo dispatch.
  [[ -n "$mbx" ]] || { echo 'Install mbx with mise and expose it on PATH.' >&2; exit 127; }
  export MBX_CARGO_SHIM_MODE=1 MBX_CARGO_SHIM_PATH="$mbx"
  exec "$mbx" "$@"
fi
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  # Runners start empty and never share an mbx store, so mbx cannot hit there.
  # Keep the same toolchain and target; tests.yaml caches dependency outputs.
  if [[ "${DESKTOP_CI_SHARED_ONLY:-}" != 1 ]]; then
    python3 scripts/prepare-patches.py
  fi
  exec cargo "$@"
fi
if [[ -z "$mbx" ]]; then
  echo 'Install mbx with mise and expose it on PATH.' >&2; exit 127
fi
python3 scripts/prepare-patches.py
exec "$mbx" "$@"
