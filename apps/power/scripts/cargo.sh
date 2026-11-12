#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
desktop="$PWD/../desktop"
export RUSTUP_HOME="$desktop/.tools/rustup" RUSTUP_TOOLCHAIN=1.98.1
# Resolve before adding checkout tools, which may contain an obsolete mbx.
mbx="$(command -v mbx || true)"
export PATH="$desktop/.tools/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$PWD/target" MACOSX_DEPLOYMENT_TARGET=15.0
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  exec cargo "$@"
fi
if [[ -z "$mbx" ]]; then
  echo 'Install mbx with mise and expose it on PATH.' >&2; exit 127
fi
exec "$mbx" "$@"
