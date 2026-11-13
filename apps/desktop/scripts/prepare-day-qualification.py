#!/usr/bin/env python3
"""Fetch locked dependencies on an ephemeral CI runner, without compiling/signing."""
from pathlib import Path
import shutil
import subprocess
import tempfile

import bundle_runtime as bundle
import day_build_inputs as day


def main():
    root = bundle.ROOT
    day.release_lock(root / "apps/day/native/Cargo.lock")
    cargo = root / "apps/day/scripts/cargo"
    for manifest in ("apps/day/native/Cargo.toml", "apps/desktop/updater/Cargo.toml"):
        subprocess.run([cargo, "fetch", "--locked", "--target", day.TARGET,
                        "--manifest-path", root / manifest], cwd=root, check=True, timeout=600)
    # Same isolated visual-worker recipe and lock-subset admission as the input
    # builder. Never resolve or build the GPUI workspace to prepare Day inputs.
    with tempfile.TemporaryDirectory(prefix="day-visual-deps-") as directory:
        visual = Path(directory) / "visual-worker"
        shutil.copytree(root / "apps/desktop/visual-worker", visual,
                        ignore=shutil.ignore_patterns("target", "Cargo.lock"))
        with (visual / "Cargo.toml").open("a") as stream:
            stream.write("\n[workspace]\n")
        seed = root / "apps/day/visual-worker.Cargo.lock"
        shutil.copyfile(seed, visual / "Cargo.lock")
        subprocess.run([cargo, "metadata", "--format-version=1", "--manifest-path", visual / "Cargo.toml"],
                       cwd=root, check=True, stdout=subprocess.DEVNULL, timeout=600)
        day.visual_lock(seed, visual / "Cargo.lock")
        subprocess.run([cargo, "fetch", "--locked", "--target", day.TARGET,
                        "--manifest-path", visual / "Cargo.toml"], cwd=root, check=True, timeout=600)
    subprocess.run(["python3", root / "apps/desktop/scripts/prepare-visual-worker.py"],
                   cwd=root, check=True, timeout=120)


if __name__ == "__main__":
    main()
