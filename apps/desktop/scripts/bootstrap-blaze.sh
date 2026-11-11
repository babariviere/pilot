#!/usr/bin/env bash
# Explicit local-only experiment. Keep normal bootstrap/CI pins untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ]]; then
  echo 'Blaze is local development only, not CI.' >&2; exit 1
fi
case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    target=aarch64-apple-darwin
    blaze_sha=29e29754367ae1b35d519194dcadded0699505a660fed07b48b4dc704428fb99 ;;
  Linux:x86_64)
    target=x86_64-unknown-linux-gnu
    blaze_sha=c5202bfb3c29920831149db9b7060c58e9876972aba3cbcd73e9e4ccaf818330 ;;
  Linux:aarch64)
    target=aarch64-unknown-linux-gnu
    blaze_sha=bca650706326725b390a8b251a58d3f0b248e648237eab6fb6b565ab8e0a6388 ;;
  *) echo 'Blaze requires Apple Silicon macOS or GNU Linux.' >&2; exit 1 ;;
esac
mkdir -p .tools/blaze/bin
download() {
  local url="$1" archive="$2" sha="$3"
  curl --fail --location --retry 2 "$url" -o "$archive"
  python3 - "$archive" "$sha" <<'PY'
import hashlib, pathlib, sys
if hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() != sys.argv[2]:
    raise SystemExit('Development tool archive SHA256 mismatch')
PY
}
# Published nightly asset from 8b15e4b406f010f98eb456ec867e16e0a9ebb0d5.
# Its hash is pinned: a replacement of the mutable nightly tag must fail.
download "https://github.com/indexable-inc/blaze/releases/download/nightly/ra-jit-$target.tar.gz" .tools/blaze/archive.tar.gz "$blaze_sha"
tar -xzf .tools/blaze/archive.tar.gz -C .tools/blaze/bin --strip-components=1
export RUSTUP_HOME="$PWD/.tools/rustup"
rustup toolchain install 1.99.0 --profile minimal --component rust-src --no-self-update
.tools/blaze/bin/ra-jit --version
python3 scripts/prepare-patches.py --fetch
