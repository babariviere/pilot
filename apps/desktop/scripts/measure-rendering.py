#!/usr/bin/env python3
"""Bounded macOS headless workload observations. No GUI/smoothness comparison.

Pass the rendering executable printed by cargo test --test rendering --no-run.
Freeze it before measurement and use a credential-free environment. Never run
against real Local data or alter the user's auth/runtime/service configuration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("executable", type=Path)
args = parser.parse_args()
if platform.system() != "Darwin":
    raise SystemExit("This measurement wrapper requires macOS /usr/bin/time -l")
source = args.executable.resolve(strict=True)
with tempfile.TemporaryDirectory(prefix="pilot-next-render-") as temporary:
    root = Path(temporary)
    frozen = root / "rendering"
    shutil.copy2(source, frozen)
    digest = hashlib.sha256(frozen.read_bytes()).hexdigest()
    results = []
    for case in ["normal", "giant"]:
        environment = {"PATH": "/usr/bin:/bin", "HOME": str(root), "TMPDIR": temporary,
                       "LANG": "en_US.UTF-8"}
        if case == "giant":
            environment["PILOT_NEXT_LARGE_RENDER"] = "1"
        result = subprocess.run(["/usr/bin/time", "-l", str(frozen)], env=environment,
                                capture_output=True, text=True, timeout=120, check=True)
        rss = re.search(r"(\d+)\s+maximum resident set size", result.stderr)
        first = re.search(r"first render_frame: ([\d.]+) ms", result.stdout)
        results.append({"case": case, "peak_rss_bytes": int(rss[1]) if rss else None,
                        "first_render_frame_cpu_ms": float(first[1]) if first else None,
                        "output": result.stdout.strip()})
    print(json.dumps({"binary_sha256": digest, "profile": "debug", "offscreen": True,
                      "not_smoothness_or_swift_comparison": True, "runs": results}, indent=2))
