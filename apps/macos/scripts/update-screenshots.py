#!/usr/bin/env python3
"""Regenerate the three README screenshots from an installed Pilot app, without building."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCES = ("session-changes.png", "ask-chat.png", "mission-window-tasks-1360.png")


def run(command):
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=300).stdout.strip()


def dimensions(path):
    return tuple(map(int, run(["magick", "identify", "-format", "%w %h", str(path)]).split()))


def render(app, captures, home):
    if not (app / "Contents/MacOS/Pilot").is_file():
        raise ValueError(f"No Pilot executable in {app}")
    for flags in ([], ["--missions-only"]):
        run([
            "open", "-n", "-W",
            "--env", f"HOME={home}",
            "--env", f"CFFIXED_USER_HOME={home}",
            "--env", f"PILOT_HOME={home / 'pilot'}",
            "--env", f"PILOT_AGENT_DIR={home / 'agent'}",
            str(app), "--args", "--snapshot", str(captures), *flags,
        ])


def update(captures, output):
    for name in SOURCES:
        if not (captures / name).is_file():
            raise ValueError(f"Missing fixture capture: {captures / name}")
    build_width, build_height = dimensions(captures / SOURCES[0])
    ask_width, ask_height = dimensions(captures / SOURCES[1])
    mission_width, mission_height = dimensions(captures / SOURCES[2])
    if build_width <= 280 or min(build_height, ask_width, ask_height) <= 0:
        raise ValueError("Invalid chat capture dimensions")
    if mission_width % 1360 or mission_width < 2720:
        raise ValueError("Mission capture must be Retina-sized (at least 2720 pixels wide)")
    scale = mission_width // 1360
    if mission_height < 653 * scale:
        raise ValueError("Mission capture is too short for the task list")

    # Stage every image before replacing any published file. Never upscale a small capture.
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".screenshots-", dir=output) as directory:
        stage = Path(directory)
        crops = (
            (SOURCES[0], "readme-build.png", f"{build_width - 280}x{build_height}+280+0"),
            (SOURCES[2], "readme-mission.png", f"{1050 * scale}x{600 * scale}+{310 * scale}+{53 * scale}"),
        )
        for source, target, geometry in crops:
            run(["magick", str(captures / source), "-crop", geometry, "+repage", "-strip", str(stage / target)])
        shutil.copyfile(captures / SOURCES[1], stage / "readme-ask.png")
        for path in sorted(stage.iterdir()):
            width, height = dimensions(path)
            if min(width, height) <= 0:
                raise ValueError(f"Invalid output: {path.name}")
        for path in sorted(stage.iterdir()):
            path.replace(output / path.name)
            print(f"Updated {output / path.name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=Path(os.environ.get("PILOT_APP", "/Applications/Pilot.app")))
    parser.add_argument("--captures", type=Path, help="Reuse an existing synthetic --snapshot directory instead of rendering")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/screenshots")
    args = parser.parse_args()
    try:
        if not shutil.which("magick"):
            raise ValueError("ImageMagick (magick) is required")
        if args.captures:
            update(args.captures.resolve(), args.output.resolve())
        else:
            if sys.platform != "darwin":
                raise ValueError("Rendering requires macOS; --captures can reuse existing fixture captures")
            with tempfile.TemporaryDirectory(prefix="pilot-readme-") as directory:
                scratch = Path(directory)
                captures, home = scratch / "captures", scratch / "home"
                captures.mkdir()
                home.mkdir()
                render(args.app.resolve(), captures, home)
                update(captures, args.output.resolve())
        print("Inspect all three images before publishing. Only synthetic fixture captures are safe to commit.")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Screenshot update failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
