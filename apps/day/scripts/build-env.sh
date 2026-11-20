#!/usr/bin/env bash
# Sourced by the two Day entry points. No global setup or shell activation.
# Match Day's checked-in toolchain, also when compiling the upstream CLI.
# An explicit caller selection remains explicit, as with ordinary Cargo.
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.99.1}"
