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
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target=aarch64-apple-darwin; sha=5927803d54f313600f7c6792369867eb26f9dfaa909b04fb5727efcf0d17b0b7 ;;
  Linux:x86_64) target=x86_64-unknown-linux-gnu; sha=decb2c1233d194d9d8f98fa926d86a5f726e9091e92fcff75f44a53ed9cab2b9 ;;
  Linux:aarch64) target=aarch64-unknown-linux-gnu; sha=30dad5b98974a37447249572c2d4f1dc065b3b774fa74f20f8a37bb73fb26767 ;;
  *) echo 'Unsupported fixture build host (macOS arm64 or Linux GNU only).' >&2; exit 1 ;;
esac
archive="$root/.tools/mbx-1.26.0-$target.tar.gz"
curl --fail --location --retry 2 "https://github.com/jdx/mr-boxington/releases/download/v1.26.0/mbx-$target.tar.gz" -o "$archive"
python3 - "$archive" "$sha" <<'PY'
import hashlib, pathlib, sys
actual = hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
if actual != sys.argv[2]:
    raise SystemExit(f'mbx SHA256 mismatch: {actual}')
print(f'mbx archive verified: sha256:{actual}')
PY
tar -xzf "$archive" -C .tools/bin mbx
.tools/bin/mbx --version
python3 scripts/prepare-patches.py --fetch
# No mbx setup, mise use --global, rustup default, or service installation.
