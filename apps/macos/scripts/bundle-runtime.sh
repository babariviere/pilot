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
runtime_source=""
if [ "$(/usr/bin/git -C "$repo" rev-parse --show-toplevel 2>/dev/null || true)" = "$repo" ]; then
	# A Swift bundle needs the same boot-bound build/root proof as Next. Stamp only
	# committed inputs, not a dirty checkout relabeled with HEAD's identity.
	runtime_source="$(/usr/bin/git -C "$repo" rev-parse HEAD)"
	/usr/bin/git -C "$repo" archive "$runtime_source" package.json pnpm-lock.yaml pnpm-workspace.yaml patches packages \
		| (cd "$stage/runtime"; tar --exclude='*.test.ts' -xf -)
else
	# Next's immutable git-archive producer stamps its own exact source after this
	# shared assembly step. An unproven standalone source tree stays unstamped.
	cp "$repo/package.json" "$repo/pnpm-lock.yaml" "$repo/pnpm-workspace.yaml" "$stage/runtime/"
	cp -R "$repo/patches" "$stage/runtime/patches"
	(cd "$repo"; tar --exclude=node_modules --exclude='*.test.ts' -cf - packages) | (cd "$stage/runtime"; tar -xf -)
fi
# Lifecycle scripts are limited to pnpm-workspace.yaml's allowBuilds. The hoisted linker keeps the
# flat node_modules layout the release has always shipped (for example node_modules/node-pty), so
# the app runtime does not depend on pnpm's virtual store or symlinks into it.
(cd "$stage/runtime"; pnpm install --prod --frozen-lockfile --config.node-linker=hoisted)
rm -rf "$stage/runtime/node_modules/.pnpm" "$stage/runtime/node_modules/.modules.yaml" \
	"$stage/runtime/node_modules/.pnpm-workspace-state-v1.json"
# Ship minified artifact libraries, so first previews never wait for esbuild inside pilotd.
(cd "$stage/runtime"; node packages/artifacts/scripts/build-libraries.ts)
(cd "$stage/runtime"; node packages/daemon/scripts/build-usage-worker.mjs build packages/daemon/src)
python3 "$here/scripts/release_metadata.py" prepare-runtime "$stage/runtime"
python3 "$here/scripts/release_metadata.py" symlinks "$stage/runtime"
if [ -n "$runtime_source" ]; then
	"$stage/runtime/node/bin/node" "$here/scripts/runtime-build.mjs" "$stage/runtime" "$runtime_source"
fi
# Copy links, not their targets. The @pilot/* workspace links must stay relative to runtime/packages.
mkdir -p "$destination"
cp -R "$stage/runtime/." "$destination/"
"$here/scripts/check-runtime.sh" "$destination"
