#!/usr/bin/env bash
# Install a production workspace in isolated staging, never prune the developer's node_modules.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
destination="${1:?Usage: bundle-runtime.sh destination}"
version="${NODE_VERSION:-24.21.0}"
[[ "$version" =~ ^24\.[0-9]+\.[0-9]+$ ]] || { echo "Expected a Node 24.x version" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
	echo "Release runtime must be built natively on arm64 macOS" >&2; exit 1;
}
stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-runtime.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
archive="node-v$version-darwin-arm64.tar.gz"
curl --fail --location --retry 3 "https://nodejs.org/dist/v$version/$archive" -o "$stage/$archive"
curl --fail --location --retry 3 "https://nodejs.org/dist/v$version/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
(cd "$stage"; grep "  $archive\$" SHASUMS256.txt > node.sha256; test -s node.sha256; shasum -a 256 -c node.sha256)
tar -xzf "$stage/$archive" -C "$stage"
node_root="$stage/node-v$version-darwin-arm64"
export PATH="$node_root/bin:$PATH"
mkdir -p "$stage/runtime/node/bin"
cp "$node_root/bin/node" "$stage/runtime/node/bin/node"
cp "$node_root/LICENSE" "$stage/runtime/node/LICENSE"
cp "$repo/package.json" "$repo/package-lock.json" "$stage/runtime/"
# tar preserves relative workspace links; exclude any existing workspace node_modules.
(cd "$repo"; tar --exclude=node_modules --exclude='*.test.ts' -cf - packages) | (cd "$stage/runtime"; tar -xf -)
# npm 11.19 gates lifecycle scripts. Approve only these locked production dependencies
# in the temporary manifest, without changing the checkout's package.json or policy.
(cd "$stage/runtime"; node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
pkg.allowScripts = Object.fromEntries(['esbuild', 'node-pty', 'fsevents', 'protobufjs', '@google/genai']
  .map(name => [`${name}@${lock.packages[`node_modules/${name}`].version}`, true]));
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
JS
)
(cd "$stage/runtime"; npm ci --omit=dev --no-audit --no-fund)
python3 "$here/scripts/release_metadata.py" prepare-runtime "$stage/runtime"
python3 "$here/scripts/release_metadata.py" symlinks "$stage/runtime"
# Copy links, not their targets. npm's @pilot/* links must stay relative to runtime/packages.
mkdir -p "$destination"
cp -R "$stage/runtime/." "$destination/"
"$here/scripts/check-runtime.sh" "$destination"
