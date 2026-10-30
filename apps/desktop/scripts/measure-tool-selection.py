#!/usr/bin/env python3
"""Run ONE frozen hidden selection fixture, with an independent <=60s deadline.

Build disclosure first through cargo.sh. Invoke this script under the existing
CPU2/4GiB mbx reserve, serially. Reports survive timeout; never use a live profile.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import shutil
import signal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("output", type=Path, help="fresh evidence directory")
    parser.add_argument("--base-patch-sha256", required=True)
    parser.add_argument("--lines", type=int, default=64)
    parser.add_argument("--width", type=int, choices=[680, 1100], default=680)
    parser.add_argument("--dark", action="store_true")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--top-only", action="store_true", help="initial attribution, no scrolling repetitions")
    parser.add_argument("--profile", action="store_true", help="separate CPU-attribution arm, not comparable timing")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    if platform.system() != "Darwin" or not 0 < args.timeout <= 60 or args.lines < 1:
        parser.error("macOS only, positive lines, deadline at most60s")
    if len(args.base_patch_sha256) != 64 or any(c not in "0123456789abcdef" for c in args.base_patch_sha256):
        parser.error("expected build-time patch SHA-256")
    args.output.mkdir(parents=True)
    root = args.output.resolve()
    frozen = root / "disclosure"
    shutil.copy2(args.executable, frozen)
    report = {"binary_sha256": hashlib.sha256(frozen.read_bytes()).hexdigest(),
              "build_time_base_patch_sha256": args.base_patch_sha256,
              "lines": args.lines, "width": args.width, "dark": args.dark, "live": args.live,
              "profiled": args.profile, "top_only": args.top_only, "deadline_seconds": args.timeout,
              "platform": platform.platform(), "offscreen": True,
              "os_clipboard": False, "stages": [], "passed": False}
    specification = importlib.util.spec_from_file_location("scoped", Path(__file__).with_name("check-scoped.py"))
    scoped = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(scoped)
    signal.signal(signal.SIGTERM, scoped.interrupted)
    signal.signal(signal.SIGINT, scoped.interrupted)
    environment = {"PATH": "/usr/bin:/bin", "HOME": str(root), "TMPDIR": str(root), "LANG": "en_US.UTF-8",
                   "PILOT_NEXT_TOOL_SELECTION_DIR": str(root),
                   "PILOT_NEXT_TOOL_SELECTION_LINES": str(args.lines),
                   "PILOT_NEXT_TOOL_SELECTION_WIDTH": str(args.width)}
    for flag, enabled in [("DARK", args.dark), ("LIVE", args.live), ("PROFILE", args.profile), ("TOP_ONLY", args.top_only)]:
        if enabled:
            environment[f"PILOT_NEXT_TOOL_SELECTION_{flag}"] = "1"
    try:
        scoped.run(["/usr/bin/env", "-i", *(f"{key}={value}" for key, value in environment.items()), str(frozen)],
                   root, args.timeout, report["stages"])
        observations = [json.loads(line) for line in (root / "stages.ndjson").read_text().splitlines()]
        assert observations[-1]["passed"] is True
        report["passed"] = True
    finally:
        (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        # Retain the frozen binary for paired readback, including failed arms.


if __name__ == "__main__":
    main()
