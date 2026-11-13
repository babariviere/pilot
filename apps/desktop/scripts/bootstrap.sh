#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == --blaze ]]; then
  exec bash scripts/bootstrap-blaze.sh
fi
root="$PWD"
export RUSTUP_HOME="$root/.tools/rustup"
mkdir -p .tools/bin
rustup toolchain install 1.98.1 --profile minimal --component rustfmt --component clippy --no-self-update
if [[ "${DESKTOP_CI_SHARED_ONLY:-}" != 1 ]]; then
  python3 scripts/prepare-patches.py --fetch
fi
# Pinned cargo-nextest for the libtest suites (local and CI). Checksummed, worktree-private.
nextest=0.9.150
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) nextest_target=universal-apple-darwin; nextest_sha=82a759b4d218d38359424196ab244c470e8f7c7d149c814fbbeef4d67c3c301a ;;
  Linux:x86_64) nextest_target=x86_64-unknown-linux-gnu; nextest_sha=b0959bc64232974224cf9fb22c915845398c0e8668fa7831eb5b43fb1eef781f ;;
  Linux:aarch64) nextest_target=aarch64-unknown-linux-gnu; nextest_sha=9164568e9840c6509177086828ac7d3178c2d8feb0658b4d2bff62fa620e98c8 ;;
  *) echo 'Unsupported cargo-nextest host (macOS arm64 or Linux GNU only).' >&2; exit 1 ;;
esac
nextest_archive="$root/.tools/downloads/cargo-nextest-$nextest-$nextest_target.tar.gz"
mkdir -p .tools/downloads
if [[ ! -f "$nextest_archive" ]]; then
  curl --fail --location --retry 2 "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-$nextest/cargo-nextest-$nextest-$nextest_target.tar.gz" -o "$nextest_archive.partial"
  mv "$nextest_archive.partial" "$nextest_archive"
fi
python3 - "$nextest_archive" "$nextest_sha" <<'PY' || { rm -f "$nextest_archive"; exit 1; }
import hashlib, pathlib, sys
actual = hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
if actual != sys.argv[2]:
    raise SystemExit(f'cargo-nextest SHA256 mismatch: {actual}')
PY
tar -xzf "$nextest_archive" -C .tools/bin cargo-nextest
.tools/bin/cargo-nextest nextest --version | head -1
# mbx is managed by mise, not installed into this checkout.
