#!/usr/bin/env python3
"""Freeze a native scaling executable; isolated sequential synthetic observations only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("executable", type=Path)
parser.add_argument("--base-patch-sha256",required=True,help="Build-time specification SHA, not the current working file")
parser.add_argument("--runs", type=int, default=3, choices=range(1, 6))
parser.add_argument("--cases", nargs="+", default=["paragraphs", "line", "fence", "open-fence"], choices=["paragraphs", "line", "fence", "open-fence"])
parser.add_argument("--sizes", nargs="+", type=int, default=[65536, 262144, 1048576], choices=[65536, 262144, 1048576])
args = parser.parse_args()
def interrupted(_signal, _frame):
    raise SystemExit(143)
signal.signal(signal.SIGTERM, interrupted)
if platform.system() != "Darwin":
    raise SystemExit("Requires macOS /usr/bin/time -l; no Wayland evidence")
source = args.executable.resolve(strict=True)
with tempfile.TemporaryDirectory(prefix="desktop-scaling-") as temporary:
    root = Path(temporary)
    frozen = root / "scaling"
    shutil.copy2(source, frozen)
    digest = hashlib.sha256(frozen.read_bytes()).hexdigest()
    specification = args.base_patch_sha256
    if not re.fullmatch(r"[0-9a-f]{64}",specification): raise SystemExit("Expected a build-time SHA-256")
    print(json.dumps({"frozen_sha256":digest,"base_patch_sha256":specification}),file=sys.stderr,flush=True)
    runs = []
    # Rotate run order to expose, rather than hide, cold/order sensitivity.
    cases = [(case, size) for size in args.sizes for case in args.cases]
    for repeat in range(args.runs):
        order = cases if repeat % 2 == 0 else list(reversed(cases))
        for case, size in order:
            environment = {"PATH": "/usr/bin:/bin", "HOME": str(root), "TMPDIR": temporary, "LANG": "en_US.UTF-8"}
            child = subprocess.Popen(["/usr/bin/time", "-l", str(frozen), case, str(size)], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
            finished = False
            try:
                stdout, stderr = child.communicate(timeout=120)
                finished = True
            except subprocess.TimeoutExpired as error:
                diagnostic=error.stderr or b""
                if isinstance(diagnostic,bytes): diagnostic=diagnostic.decode(errors="replace")
                print(json.dumps({"case":case,"bytes":size,"repeat":repeat,"timeout_seconds":120,"stderr_tail":diagnostic[-5000:]}),file=sys.stderr,flush=True)
                raise
            finally:
                if not finished:
                    try:
                        os.killpg(child.pid,signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.communicate()
            if child.returncode:
                print(json.dumps({"case":case,"size":size,"repeat":repeat,"returncode":child.returncode,"stderr_prefix":stderr[:1800]}),file=sys.stderr,flush=True)
                raise SystemExit(child.returncode)
            observation = json.loads(stdout.strip().splitlines()[-1])
            rss = re.search(r"(\d+)\s+maximum resident set size", stderr)
            observation.update(repeat=repeat, peak_rss_bytes=int(rss[1]) if rss else None)
            runs.append(observation)
            print(json.dumps(observation),file=sys.stderr,flush=True)
    assert hashlib.sha256(frozen.read_bytes()).hexdigest() == digest
    print(json.dumps({"binary_sha256": digest, "base_patch_sha256":specification, "profile": "debug", "platform": platform.platform(), "not_smoothness_or_swift_comparison": True, "runs": runs}, indent=2))
