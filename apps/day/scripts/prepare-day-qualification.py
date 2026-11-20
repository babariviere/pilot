#!/usr/bin/env python3
"""Fetch locked dependencies on an ephemeral CI runner, without compiling/signing."""
import subprocess

import bundle_runtime as bundle
import day_build_inputs as day


def main():
    root = bundle.ROOT
    day.release_lock(root / "apps/day/native/Cargo.lock")
    cargo = root / "apps/day/scripts/cargo"
    for manifest in ("apps/day/native/Cargo.toml", "crates/updater/Cargo.toml"):
        subprocess.run([cargo, "fetch", "--locked", "--target", day.TARGET,
                        "--manifest-path", root / manifest], cwd=root, check=True, timeout=600)


if __name__ == "__main__":
    main()
