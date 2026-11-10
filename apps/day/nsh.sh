#!/usr/bin/env bash
# Runs the nsh CLI built from the pinned, unmodified upstream revision.
# The checkout lives in .tools/ (ignored) and is refused if it has changes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=apps/day/scripts/build-env.sh
source "$here/scripts/build-env.sh"
rev="530b73170f61e5bf16380959de9e622f8ce130cd"
src="${NSH_DAY_SOURCE:-$here/.tools/nsh}"
git=/usr/bin/git

if [[ -n "${NSH_DAY_SOURCE:-}" ]]; then
	# An explicitly supplied checkout is borrowed, never cloned or switched.
	if [[ ! -d "$src/.git" || "$("$git" -C "$src" rev-parse HEAD)" != "$rev" ]]; then
		echo "nsh.sh: NSH_DAY_SOURCE must be an existing checkout at $rev" >&2
		exit 1
	fi
fi
if [ ! -d "$src/.git" ]; then
	mkdir -p "$(dirname "$src")"
	"$git" clone --quiet https://github.com/longbridge/nsh "$src"
fi
src="$(cd "$src" && pwd)"
if [ -n "$("$git" -C "$src" status --porcelain --untracked-files=no)" ]; then
	echo "nsh.sh: $src has local changes; Pilot Day uses unmodified upstream only" >&2
	exit 1
fi
if [ "$("$git" -C "$src" rev-parse HEAD)" != "$rev" ]; then
	"$git" -C "$src" fetch --quiet origin "$rev"
	"$git" -C "$src" checkout --quiet --detach "$rev"
fi
if [ -n "$("$git" -C "$src" status --porcelain --untracked-files=no)" ]; then
	echo "nsh.sh: $src has local changes; Pilot Day uses unmodified upstream only" >&2
	exit 1
fi
# Never write into a borrowed NSH_DAY_SOURCE target. Keep CLI and app targets
# separate even when the caller supplies CARGO_TARGET_DIR for the app.
cli_target="$here/.tools/target/nsh-$rev"
export CARGO="$here/scripts/cargo"
(cd "$src" && "$CARGO" build --locked --quiet -p nsh-cli --target-dir "$cli_target")
cd "$here"
# Native captures are written to output/ (ignored), which a fresh clone lacks.
if [ "${1:-}" = test ]; then mkdir -p output; fi
# This CLI, its describe/headless runners and the macOS UI execute locally.
# CARGO remains the adapter for nested compilation and dev-mode rebuilds.
exec "$cli_target/debug/nsh" "$@"
