#!/usr/bin/env python3
"""A tiny two-source-root mbx restore probe, NOT a GPUI build benchmark.

Uses private temp targets, the fixture's bounded shared mbx store and exact Rust
pin. Keeps logs in evidence/local; removes only its own temporary probe roots.
"""
import json
from pathlib import Path
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parent.parent
evidence = root / "evidence/local"
evidence.mkdir(parents=True, exist_ok=True)
(root / "target").mkdir(exist_ok=True)
records = []
with tempfile.TemporaryDirectory(prefix="cache-probe-", dir=root / "target") as temporary:
    for name in ["first", "second"]:
        checkout = Path(temporary) / name
        (checkout / "src").mkdir(parents=True)
        (checkout / "Cargo.toml").write_text(
            '[package]\nname = "fixture-cache-probe"\nversion = "0.0.0"\n'
            'edition = "2024"\npublish = false\n[profile.dev]\ndebug = 0\n'
        )
        (checkout / "Cargo.lock").write_text(
            'version = 4\n[[package]]\nname = "fixture-cache-probe"\nversion = "0.0.0"\n'
        )
        (checkout / "src/main.rs").write_text('fn main() { println!("fixture cache probe v1"); }\n')
        command = ["bash", str(root / "scripts/cargo.sh"), "build", "--locked",
                   "--manifest-path", str(checkout / "Cargo.toml"),
                   "--target-dir", str(checkout / "target")]
        started = time.monotonic()
        result = subprocess.run(command, cwd=root, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, check=False)
        seconds = time.monotonic() - started
        (evidence / f"cache-probe-{name}.log").write_text(result.stdout)
        records.append({"sourceRoot": name, "command": command, "seconds": seconds,
                        "exitCode": result.returncode,
                        "cache": [line for line in result.stdout.splitlines() if "mbx[cache]" in line]})
        print(result.stdout, end="", flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
(evidence / "cache-probe.json").write_text(json.dumps(records, indent=2) + "\n")
print("Two private source-root probe complete. Inspect second log for actual hits, not Cargo freshness.")
