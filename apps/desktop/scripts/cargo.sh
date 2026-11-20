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
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  # Hosted runners do not share an mbx store.
  exec cargo "$@"
fi
if [[ -z "$mbx" ]]; then
  echo 'Install mbx with mise and expose it on PATH.' >&2; exit 127
fi
exec "$mbx" "$@"
