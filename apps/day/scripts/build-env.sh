#!/usr/bin/env bash
# Sourced by the two Day entry points. No global setup or shell activation.
day="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${NSH_DAY_MBX:-}" ]]; then
	if [[ -x "$day/.tools/bin/mbx" ]]; then
		NSH_DAY_MBX="$day/.tools/bin/mbx"
	elif [[ -x "$day/../desktop/.tools/bin/mbx" ]]; then
		NSH_DAY_MBX="$day/../desktop/.tools/bin/mbx"
	else
		NSH_DAY_MBX="$(command -v mbx || true)"
	fi
fi
NSH_DAY_MBX="$(command -v "$NSH_DAY_MBX" || true)"
if [[ -z "$NSH_DAY_MBX" || ! -x "$NSH_DAY_MBX" ]]; then
	echo 'Day requires mbx 1.26.0. Run bash apps/day/scripts/bootstrap.sh, or set NSH_DAY_MBX to its executable.' >&2
	exit 127
fi
NSH_DAY_MBX="$(cd "$(dirname "$NSH_DAY_MBX")" && pwd)/$(basename "$NSH_DAY_MBX")"
mbx_version="$("$NSH_DAY_MBX" --version)"
if [[ "$mbx_version" != 'mbx 1.26.0' ]]; then
	echo 'Day requires mbx 1.26.0; other versions must not migrate the shared 1.26 cache.' >&2
	exit 1
fi
if [[ -n "${MBX_SOCKET:-}" ]]; then
	echo 'Start Day outside an existing mbx build session.' >&2
	exit 1
fi
# Match Day's checked-in toolchain, also when compiling the upstream CLI.
# An explicit caller selection remains explicit, as with ordinary Cargo.
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.99.1}"
NSH_DAY_REAL_CARGO="${NSH_DAY_REAL_CARGO:-${CARGO:-$(command -v cargo || true)}}"
NSH_DAY_REAL_CARGO="$(command -v "$NSH_DAY_REAL_CARGO" || true)"
if [[ -z "$NSH_DAY_REAL_CARGO" || ! -x "$NSH_DAY_REAL_CARGO" || "$NSH_DAY_REAL_CARGO" == "$day/scripts/cargo" ]]; then
	echo 'Day requires a real Cargo executable (or an explicit CARGO path).' >&2
	exit 127
fi
NSH_DAY_REAL_CARGO="$(cd "$(dirname "$NSH_DAY_REAL_CARGO")" && pwd)/$(basename "$NSH_DAY_REAL_CARGO")"
export NSH_DAY_MBX NSH_DAY_REAL_CARGO
# Same versioned cache and admission pool as the existing desktop build path.
# Targets stay private. Do not adopt targets, collect others' caches, use remote
# credentials, or opt into Blaze through ambient configuration.
export MBX_CACHE_DIR="${MBX_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/gpui-fixture-mbx-v1}"
export MBX_SCHEDULER=1 MBX_SCHEDULER_CPUS=2 MBX_SCHEDULER_MEMORY=4GiB
export MBX_TARGET_VIEWS=0 MBX_GC_AUTO=0 MBX_REMOTE_URL="" MBX_BLAZE=0 MBX_DISABLE=0
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
