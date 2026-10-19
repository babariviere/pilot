#!/usr/bin/env bash
# Native CI packaging only. Never install/build dependencies on the destination devbox.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
destination="${1:?Usage: bundle-runtime.sh output-directory}"
[ "$(uname -s)/$(uname -m)" = Linux/x86_64 ] || { echo 'Native Linux x86-64 packaging required' >&2; exit 1; }
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$destination" "$stage/runtime/bin"
destination="$(cd "$destination" && pwd)"
node_version=24.21.0
node_sha=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
jj_version=0.46.0
jj_sha=fce0271158e665ceb82dc66c5eb95b1728649094e9133074f3b5baece345fc08
curl -fLsS --retry 3 "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.gz" -o "$stage/node.tgz"
echo "$node_sha  $stage/node.tgz" | sha256sum -c -
tar -xzf "$stage/node.tgz" -C "$stage"
node_root="$stage/node-v$node_version-linux-x64"
export PATH="$node_root/bin:$PATH"
mkdir -p "$stage/runtime/node/bin"
cp "$node_root/bin/node" "$stage/runtime/node/bin/"
cp "$node_root/LICENSE" "$stage/runtime/node/"
curl -fLsS --retry 3 "https://github.com/jj-vcs/jj/releases/download/v$jj_version/jj-v$jj_version-x86_64-unknown-linux-musl.tar.gz" -o "$stage/jj.tgz"
echo "$jj_sha  $stage/jj.tgz" | sha256sum -c -
mkdir "$stage/jj"
tar -xzf "$stage/jj.tgz" -C "$stage/jj"
cp "$stage/jj/jj" "$stage/runtime/bin/"
cp -R "$stage/jj" "$stage/runtime/jj-licenses"
rm "$stage/runtime/jj-licenses/jj"
cp "$repo/package.json" "$repo/pnpm-lock.yaml" "$repo/pnpm-workspace.yaml" "$stage/runtime/"
cp -R "$repo/patches" "$stage/runtime/patches"
(cd "$repo"; tar --exclude=node_modules --exclude='*.test.ts' -cf - packages) | (cd "$stage/runtime"; tar -xf -)
# Private build tool, not a global install. Native addons compile against the shipped Node headers.
manager="$(node -p "require('$repo/package.json').packageManager")"
[[ "$manager" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]]
npm install --prefix "$stage/tools" --ignore-scripts --no-audit --no-fund "$manager"
# pnpm's standalone distribution does not supply node-gyp. Reuse the one in the checksum-pinned
# Node/npm archive, only in this private CI build-tools directory.
ln -s "$node_root/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js" "$stage/tools/node_modules/.bin/node-gyp"
export PATH="$stage/tools/node_modules/.bin:$PATH"
export npm_config_nodedir="$node_root"
export npm_config_build_from_source=true
export LDFLAGS="-static-libstdc++ -static-libgcc"
(cd "$stage/runtime"; "$stage/tools/node_modules/.bin/pnpm" install --prod --frozen-lockfile --config.node-linker=hoisted)
rm -rf "$stage/runtime/node_modules/.pnpm" "$stage/runtime/node_modules/.modules.yaml" "$stage/runtime/node_modules/.pnpm-workspace-state-v1.json"
(cd "$stage/runtime"; node packages/artifacts/scripts/build-libraries.ts)
cp "$repo/scripts/linux/"{service.mjs,check-runtime.mjs} "$stage/runtime/"
mkdir -p "$stage/runtime/scripts/linux"
cp "$repo/scripts/linux/"{update.mjs,service.mjs,release-manifest.mjs} "$stage/runtime/scripts/linux/"
printf '%s\n' '#!/bin/sh' 'root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)' 'exec "$root/node/bin/node" "$root/service.mjs" "$@"' > "$stage/runtime/bin/pilot-runtime"
chmod 755 "$stage/runtime/bin/"* "$stage/runtime/node/bin/node"
python3 "$repo/scripts/linux/runtime-metadata.py" prepare "$stage/runtime"
python3 "$repo/scripts/linux/runtime-metadata.py" audit "$stage/runtime"
(cd "$stage/runtime"; ./node/bin/node check-runtime.mjs)
tar -czf "$destination/Pilot-linux-x64.tar.gz" -C "$stage" runtime
# Relocate and remove staging before executing the production package again.
mkdir "$stage/relocated"
tar -xzf "$destination/Pilot-linux-x64.tar.gz" -C "$stage/relocated"
rm -rf "$stage/runtime"
(cd "$stage/relocated/runtime"; ./node/bin/node check-runtime.mjs)
cp "$stage/relocated/runtime/runtime-abi.json" "$destination/runtime-abi.json"
node "$repo/scripts/linux/release-manifest.mjs" create "$destination" "$stage/relocated/runtime"
