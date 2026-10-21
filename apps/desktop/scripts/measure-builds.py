#!/usr/bin/env python3
"""Single-run build-loop observations, not a Swift or cross-worktree A/B.

No GUI launch. Serial commands, bounded through cargo.sh. The edit phase adds
one comment to lib.rs, then restores the exact original bytes in finally.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parent.parent
evidence = root / "evidence/local"
evidence.mkdir(parents=True, exist_ok=True)
records = []


def run(label):
    command = ["bash", str(root / "scripts/cargo.sh"), "build", "--locked"]
    if sys.platform == "darwin":
        command = ["/usr/bin/time", "-l", *command]
    started = time.monotonic()
    result = subprocess.run(command, cwd=root, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, check=False)
    seconds = time.monotonic() - started
    (evidence / f"build-{label}.log").write_text(result.stdout)
    records.append({"phase": label, "seconds": seconds, "exitCode": result.returncode,
                    "command": command,
                    "cache": [line for line in result.stdout.splitlines() if "mbx[cache]" in line]})
    (evidence / "build-loop.json").write_text(json.dumps(records, indent=2) + "\n")
    print(f"{label}: {seconds:.3f}s, exit={result.returncode}", flush=True)
    if result.returncode:
        print(result.stdout)
        raise SystemExit(result.returncode)


run("baseline")
run("warm")
source = root / "src/lib.rs"
original = source.read_bytes()
edited = original + b"\n// Reproducible one-file build-loop probe, restored after measurement.\n"
try:
    source.write_bytes(edited)
    run("one-file-edit")
finally:
    # Do not clobber a concurrent edit by another owner.
    if source.read_bytes() != edited:
        raise RuntimeError("lib.rs changed concurrently; leaving it untouched")
    source.write_bytes(original)
run("restored")
print("lib.rs restored exactly:", hashlib.sha256(original).hexdigest())
