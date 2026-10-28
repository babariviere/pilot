#!/usr/bin/env python3
"""CI-only, non-release full-payload assembly/relocation smoke. Not GUI acceptance."""
import argparse
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

import bundle_runtime as bundle


def qualify(expected_source, output):
    bundle.source(expected_source)
    if os.environ.get("GITHUB_ACTIONS") != "true" or (sys.platform, platform.machine()) != ("darwin", "arm64"):
        raise ValueError("Run only on an allowed macOS arm64 CI build host; this builds real Swift helpers")
    if bundle.run("/usr/bin/git", "rev-parse", "HEAD", cwd=bundle.ROOT) != expected_source:
        raise ValueError("Source must be the exact checked-out commit (including a PR's tested merge commit)")
    output = output.resolve()
    if not output.is_relative_to(Path(os.environ["RUNNER_TEMP"]).resolve()):
        raise ValueError("Use a fresh private output under RUNNER_TEMP")
    output.mkdir(mode=0o700)
    evidence = output / "evidence"
    evidence.mkdir(mode=0o700)
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("PILOT_", "PI_", "NODE_", "NPM_CONFIG_", "npm_config_"))}
    for key, name in (("HOME", "home"), ("TMPDIR", "tmp"), ("XDG_CONFIG_HOME", "config"),
                      ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("CARGO_HOME", "cargo")):
        path = output / name
        path.mkdir(mode=0o700)
        env[key] = str(path)
    env.update(PILOT_SWIFT_JOBS="2", CARGO_BUILD_JOBS="2", MAKEFLAGS="-j2", CMAKE_BUILD_PARALLEL_LEVEL="2")
    report = dict(schema=1, kind="non-release-macos-bundle-smoke", source=expected_source,
                  host=platform.mac_ver()[0], arch="arm64", passed=False, full_acceptance=False,
                  gui_startup_executed=False, steps=[])

    def command(name, args, timeout):
        step = dict(name=name, argv=args, exit_code=None)
        report["steps"].append(step)
        started = time.monotonic()
        print(f"macOS bundle smoke: {name}", flush=True)
        try:
            with (evidence / (name + ".log")).open("w") as log:
                result = subprocess.run(args, cwd=bundle.ROOT, env=env, stdout=log,
                                        stderr=subprocess.STDOUT, check=True, timeout=timeout)
            step["exit_code"] = result.returncode
        except subprocess.CalledProcessError as error:
            step["exit_code"] = error.returncode
            raise
        finally:
            step["seconds"] = time.monotonic() - started

    script = str(Path(bundle.__file__).resolve())
    try:
        for stage in ("runtime", "native", "rust"):
            command(stage, [sys.executable, script, stage, "--source", expected_source,
                            "--output", str(output / stage)], 5100)
        app = output / "assembly/Pilot Next.app"
        app.parent.mkdir()
        command("bundle", [sys.executable, script, "bundle", "--source", expected_source,
                           "--runtime", str(output / "runtime"), "--native", str(output / "native"),
                           "--executables", str(output / "rust"), "--output", str(app)], 600)
        moved = output / "relocated GUI/Pilot Next.app"
        moved.parent.mkdir()
        app.rename(moved)
        for stage in ("runtime", "native", "rust"):
            shutil.rmtree(output / stage)  # Only our fresh inputs, never an installed app.
        command("verify-relocated", [sys.executable, script, "verify", str(moved)], 600)
        command("verify-seal", ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(moved)], 60)
        started = time.monotonic()
        binaries = bundle.native_closure(moved)  # Full architecture/dependency/minOS audit after relocation.
        report["native_closure_seconds"] = time.monotonic() - started
        report["native_binaries"] = [str(path.relative_to(moved)) for path in binaries]
        command("offline-runtime", ["/bin/bash", str(bundle.ROOT / "apps/macos/scripts/check-runtime.sh"),
                                    str(moved / "Contents/Resources/runtime")], 300)
        # --help returns before GPUI/window/profile/daemon startup. Never launch no-arg or --bundled here.
        command("gui-help", [str(moved / "Contents/MacOS/pilot-desktop"), "--help"], 30)
        for name in ("bundled-runtime", "native-inputs", "rust-inputs", "updater-inputs"):
            shutil.copyfile(moved / f"Contents/Resources/{name}.json", evidence / (name + ".json"))
        report["inventory_sha256"] = bundle.digest(evidence / "bundled-runtime.json")
        # The outer inventory deliberately omits the GUI executable's resource seal.
        report["sealed_gui_sha256"] = bundle.digest(moved / "Contents/MacOS/pilot-desktop")
        report["passed"] = True
    finally:
        bundle.write_json(evidence / "report.json", report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    qualify(args.source, args.output)


if __name__ == "__main__":
    main()
