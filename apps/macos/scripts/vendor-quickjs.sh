#!/usr/bin/env bash
# Vendor QuickJS-NG's C sources at the release the kernel's quickjs-wasi embeds, so a visual's publish-time
# pre-check and the app's sandboxed visual engine run the same engine. scripts/tests/quickjs-version.test.mjs
# fails when this pin and quickjs-wasi's reported version diverge; bump both together.
set -euo pipefail

version="0.17.0"
sha256="559bc4c420475e55c7ab4510adbc562f55d7524d75e8e89d79ce4bb02f5687d9"
here="$(cd "$(dirname "$0")/.." && pwd)"
target="$here/Vendor/QuickJSNG"
stamp="$version $sha256"

if [ "${1:-}" = --version ]; then
	echo "$version"
	exit 0
fi

if [ ! -f "$target/.pilot-version" ] || [ "$(cat "$target/.pilot-version")" != "$stamp" ]; then
	stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-quickjs.XXXXXX")"
	trap 'rm -rf "$stage"' EXIT
	curl --fail --silent --show-error --location --retry 3 \
		"https://github.com/quickjs-ng/quickjs/archive/refs/tags/v$version.tar.gz" -o "$stage/quickjs.tar.gz"
	printf '%s  %s\n' "$sha256" "$stage/quickjs.tar.gz" | shasum -a 256 --check --status || {
		echo "QuickJS-NG v$version archive checksum mismatch" >&2
		exit 1
	}
	tar -xzf "$stage/quickjs.tar.gz" -C "$stage"
	source="$stage/quickjs-$version"
	grep -q "#define QJS_VERSION_MINOR $(echo "$version" | cut -d. -f2)$" "$source/quickjs.h" || {
		echo "QuickJS-NG v$version sources report another version" >&2
		exit 1
	}
	rm -rf "$target"
	mkdir -p "$target/src/include"
	# The engine only: no quickjs-libc (std/os modules, files, timers), CLI, tests or examples.
	for file in quickjs.c quickjs.h quickjs-atom.h quickjs-opcode.h quickjs-c-atomics.h cutils.h list.h \
		dtoa.c dtoa.h libregexp.c libregexp.h libregexp-opcode.h libunicode.c libunicode.h libunicode-table.h \
		builtin-array-fromasync.h builtin-iterator-zip-keyed.h builtin-iterator-zip.h; do
		cp "$source/$file" "$target/src/$file"
	done
	cp "$source/quickjs.h" "$target/src/include/quickjs.h"
	cp "$source/LICENSE" "$target/LICENSE"
	echo "$stamp" >"$target/.pilot-version"
fi
