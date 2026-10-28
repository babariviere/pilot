#!/usr/bin/env python3
"""Stage two pinned crates locally, never edit Cargo's shared checkout."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tomllib

HERE = Path(__file__).resolve().parent
REV = "c7b249970c2f9a15e20c5a461a7324ea9227c08f"
URL = "https://github.com/longbridge/nsh"
checkouts = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "git/checkouts"
source = next((p for p in checkouts.glob("nsh-*/*") if p.is_dir() and
               subprocess.check_output(["/usr/bin/git", "-C", str(p), "rev-parse", "HEAD"], text=True).strip() == REV), None)
if source is None:
    bootstrap = HERE / "output/bootstrap"
    bootstrap.mkdir(parents=True, exist_ok=True)
    (bootstrap / "lib.rs").write_text("")
    (bootstrap / "Cargo.toml").write_text(
        '[package]\nname="nsh-source-fetch"\nversion="0.0.0"\nedition="2024"\n'
        '[workspace]\n[lib]\npath="lib.rs"\n[dependencies]\n'
        f'nsh-core = {{ git="{URL}", rev="{REV}" }}\n')
    subprocess.run(["cargo", "fetch", "--manifest-path", str(bootstrap / "Cargo.toml")], check=True)
    source = next(p for p in checkouts.glob("nsh-*/*") if p.is_dir() and
                  subprocess.check_output(["/usr/bin/git", "-C", str(p), "rev-parse", "HEAD"], text=True).strip() == REV)
workspace = tomllib.loads((source / "Cargo.toml").read_text())["workspace"]


def toml(value):
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{json.dumps(k)} = {toml(v)}" for k, v in value.items()) + " }"
    return json.dumps(value)


for name in ["nsh-core", "nsh-platform-macos"]:
    dest = HERE / "output/patched" / name
    patch = HERE / "patches" / f"{name}.patch"
    baseline = os.environ.get("NSH_CHAT_BASELINE") == "1"
    digest = hashlib.sha256(REV.encode() + patch.read_bytes() + Path(__file__).read_bytes() + str(baseline).encode()).hexdigest()
    marker = dest / ".prepared"
    if marker.exists() and marker.read_text() == digest:
        continue
    # Baseline/restored sources must invalidate Cargo's mtime fingerprints too.
    shutil.copytree(source / "crates" / name, dest, dirs_exist_ok=True, copy_function=shutil.copy)
    if not baseline:
        subprocess.run(["patch", "-p1", "--batch", "--fuzz=0", "-i", str(patch)], cwd=dest, check=True)
    manifest = tomllib.loads((dest / "Cargo.toml").read_text())
    for key, value in manifest["package"].items():
        if isinstance(value, dict) and value.get("workspace"):
            value = workspace["package"][key]
            manifest["package"][key] = str(source / value) if key == "readme" else value
    manifest["lints"] = workspace["lints"]

    def inherit_dependencies(table):
        for section, entries in table.items():
            if section.endswith("dependencies"):
                for key, spec in entries.items():
                    if isinstance(spec, dict) and spec.get("workspace"):
                        base = workspace["dependencies"][key]
                        base = {"version": base} if isinstance(base, str) else dict(base)
                        if "path" in base:
                            del base["path"]
                            base.update(git=URL, rev=REV)
                        extra = {k: v for k, v in spec.items() if k != "workspace"}
                        if "features" in extra:
                            extra["features"] = base.get("features", []) + extra["features"]
                        entries[key] = dict(base, **extra)
            elif isinstance(entries, dict):
                inherit_dependencies(entries)

    inherit_dependencies(manifest)
    manifest["workspace"] = {}
    (dest / "Cargo.toml").write_text("\n".join(f"{k} = {toml(v)}" for k, v in manifest.items()) + "\n")
    marker.write_text(digest)
