#!/usr/bin/env python3
"""Synthetic native helper lifecycle only. Own processes/temp apps, no installed app/feed/key access."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
DESKTOP = ROOT / "apps/desktop"
PUBLIC_KEY = "GX9rI+FshTLGq8g4+s1ep4m+DHaykgM0A5v6iz02jWE="  # public TEST seed42 only
PHASES = frozenset("preparation exit_observation_bound blackout_upper_bound blackout_through_ack_upper_bound helper_prepare commit_wait parent_exit_wait exited_target_verify exited_archive_verify exited_extract_sync exited_candidate_verify exited_guard_verify swap_journal_sync relaunch_command prepared_archive_verify prepared_extract_sync prepared_candidate_closure_verify exited_closure_hash".split())


def phase_timings(output):
    return [(name, float(seconds)) for name, seconds in re.findall(
        r"^lifecycle-phase ([a-z_]+) ([0-9]+\.[0-9]+)$", output, re.MULTILINE)
        if name in PHASES]


def hashes():
    paths = [p for p in (DESKTOP / "updater").rglob("*")
             if p.is_file() and p.suffix in (".rs", ".m", ".toml", ".lock") and "target" not in p.parts]
    paths += [ROOT / "packages/daemon/src" / name for name in ("runtime-owner.ts", "update-reservation.ts")]
    paths += [Path(__file__).resolve()]
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}


def inside(output, app_only=False, timings=False):
    output = Path(output).resolve(strict=True)
    temporary = Path(tempfile.gettempdir()).resolve(strict=True)
    if not output.is_relative_to(temporary) or output.stat().st_uid != os.getuid() or output.stat().st_mode & 0o077:
        raise ValueError("Private owned temporary output required")
    before = hashes()
    commands = []
    receipt = dict(kind="synthetic-native-updater-lifecycle", production=False, source=before, commands=commands)
    try:
        inputs = output / "inputs"
        env = {key: value for key, value in os.environ.items() if not key.startswith(("PILOT_", "PI_", "NODE_"))}
        env.update(PILOT_NEXT_UPDATER_PUBLIC_KEY=PUBLIC_KEY,
                   PILOT_NEXT_UPDATER_REPOSITORY="synthetic/fixture-only",
                   PILOT_NEXT_UPDATER_APPLICATION_ID="com.example.synthetic.next",
                   PILOT_NEXT_UPDATER_CODE_REQUIREMENT=("signed-linux-inventory-v1" if sys.platform == "linux" else 'identifier "com.example.synthetic.next"'))
        for name, build in (("old", "100.1"), ("new", "101.1")):
            env["PILOT_NEXT_UPDATER_BUILD"] = build
            command = ["bash", "apps/desktop/scripts/cargo.sh", "build", "--manifest-path", "updater/Cargo.toml",
                       "--locked", "--features", ("native-linux" if sys.platform == "linux" else "native-macos") + ",lifecycle-timings", "--bin", "pilot-desktop-update-helper",
                       "--example", "lifecycle-fixture"]
            started = time.monotonic()
            subprocess.run(command, cwd=ROOT, env=env, check=True, timeout=1200)
            directory = inputs / name
            directory.mkdir(parents=True)
            binaries = []
            for binary, path in (("pilot-desktop-update-helper", DESKTOP / "target/dev/debug/pilot-desktop-update-helper"),
                                 ("lifecycle-fixture", DESKTOP / "target/dev/debug/examples/lifecycle-fixture")):
                shutil.copyfile(path, directory / binary)
                (directory / binary).chmod(0o755)
                binaries.append(dict(name=binary, bytes=path.stat().st_size,
                                     sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
            commands.append(dict(build=build, argv=command, seconds=time.monotonic() - started, binaries=binaries))
        node = subprocess.check_output(["node", "-p", "process.execPath"], text=True, timeout=5).strip()
        fixtures = output / "relocated GUI fixtures"
        fixtures.mkdir(mode=0o700)
        modes = ("--verify-external", "--verify-ui-only") if app_only else ("--verify", "--verify-cancel", "--verify-expired", "--verify-interrupted", "--verify-startup-fails", "--verify-external", "--verify-ui-only")
        if not app_only and not timings and sys.platform == "darwin":
            modes += ("--verify-prepared-tamper",)
        if timings:
            modes = ("--verify-timings",) * 3
        observations = []
        receipt["observations"] = observations
        for index, mode in enumerate(modes):
            fixture = fixtures / f"{index}-{mode.removeprefix('--')}"
            fixture.mkdir(mode=0o700)
            result = subprocess.run([str(inputs / "old/lifecycle-fixture"), mode, str(fixture), str(inputs), node],
                                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=240)
            # Only allowlisted numeric phases enter the timing report. Never export
            # fixture paths, daemon identity or subprocess diagnostics as timings.
            phases = phase_timings(result.stdout + result.stderr)
            observations.append(dict(mode=mode, phases=phases))
            print(json.dumps(observations[-1]), flush=True)
            if result.returncode:
                print(result.stderr, file=sys.stderr)
                result.check_returncode()
        receipt["passed"] = True
    finally:
        receipt["sourceUnchanged"] = before == hashes()
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (output / "receipt.json").chmod(0o600)
        print(f"Synthetic receipt and retained evidence: {output}", flush=True)
    if not receipt["sourceUnchanged"]:
        raise RuntimeError("Source changed during qualification")


def main():
    if (sys.platform, platform.machine()) not in (("darwin", "arm64"), ("linux", "x86_64")):
        raise SystemExit("Native arm64 macOS or x86_64 Linux fixture required")
    if sys.argv[1:] not in ([], ["--app-only"], ["--timings"]):
        raise SystemExit("No application path, credential, feed or signing-key arguments are accepted")
    output = tempfile.mkdtemp(prefix="next-owned-update-")
    inside(output, app_only=sys.argv[1:] == ["--app-only"], timings=sys.argv[1:] == ["--timings"])


if __name__ == "__main__":
    main()
