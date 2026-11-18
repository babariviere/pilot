#!/usr/bin/env bash
# Sourced by the two Day entry points. No global setup or shell activation.
day="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Match Day's checked-in toolchain, also when compiling the upstream CLI.
# An explicit caller selection remains explicit, as with ordinary Cargo.
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.99.1}"
NSH_DAY_REAL_CARGO="$(command -v "${NSH_DAY_REAL_CARGO:-cargo}" || true)"
if [[ ! -f "$NSH_DAY_REAL_CARGO" || ! -x "$NSH_DAY_REAL_CARGO" || "$NSH_DAY_REAL_CARGO" -ef "$day/scripts/cargo" ]]; then
	echo 'Day requires Cargo on PATH or an explicit NSH_DAY_REAL_CARGO executable.' >&2
	exit 127
fi
NSH_DAY_REAL_CARGO="$(cd "$(dirname "$NSH_DAY_REAL_CARGO")" && pwd)/$(basename "$NSH_DAY_REAL_CARGO")"
export NSH_DAY_REAL_CARGO
