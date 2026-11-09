#!/usr/bin/env bash
# Runs the nsh CLI built from the pinned, unmodified upstream revision.
# The checkout lives in .tools/ (ignored) and is refused if it has changes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rev="530b73170f61e5bf16380959de9e622f8ce130cd"
src="${NSH_DAY_SOURCE:-$here/.tools/nsh}"
git=/usr/bin/git

if [ ! -d "$src/.git" ]; then
	mkdir -p "$(dirname "$src")"
	"$git" clone --quiet https://github.com/longbridge/nsh "$src"
fi
if [ "$("$git" -C "$src" rev-parse HEAD)" != "$rev" ]; then
	"$git" -C "$src" fetch --quiet origin "$rev"
	"$git" -C "$src" checkout --quiet --detach "$rev"
fi
if [ -n "$("$git" -C "$src" status --porcelain --untracked-files=no)" ]; then
	echo "nsh.sh: $src has local changes; this spike uses unmodified upstream only" >&2
	exit 1
fi
(cd "$src" && cargo build --quiet -p nsh-cli)
cd "$here"
exec "$src/target/debug/nsh" "$@"
