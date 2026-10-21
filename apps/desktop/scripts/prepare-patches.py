#!/usr/bin/env python3
"""Materialize checksummed crates + exact scoped edits into private build inputs.

Never writes Cargo's registry/cache. Tracked edit specifications are the source
of truth. Existing generated edits fail closed rather than being overwritten.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PATCHES = ROOT / "patches"
OUTPUT = ROOT / ".patched"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def prepare(spec_path):
    raw = spec_path.read_bytes()
    spec = json.loads(raw)
    name = f'{spec["crate"]}-{spec["version"]}'
    destination = OUTPUT / name
    marker_path = destination / ".fixture-patch.json"
    if marker_path.exists():
        marker = json.loads(marker_path.read_text())
        for file, expected in marker["files"].items():
            if sha((destination / file).read_bytes()) != expected:
                raise RuntimeError(f'Generated source changed: {destination / file}; refusing to overwrite')
        if marker["spec"] == sha(raw):
            return
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    archives = sorted((cargo_home / "registry/cache").glob(f'*/{name}.crate'))
    local_archive = ROOT / ".tools/downloads" / f"{name}.crate"
    if local_archive.exists():
        archives.append(local_archive)
    archives = [file for file in archives if sha(file.read_bytes()) == spec["archiveSha256"]]
    if not archives and "--fetch" in sys.argv:
        download = ROOT / ".tools/downloads" / f"{name}.crate"
        download.parent.mkdir(parents=True, exist_ok=True)
        url = f'https://static.crates.io/crates/{spec["crate"]}/{name}.crate'
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if sha(data) != spec["archiveSha256"]:
            raise RuntimeError(f'Original archive checksum mismatch: {name}')
        download.write_bytes(data)
        archives = [download]
    if not archives:
        raise RuntimeError(f'Need original crates.io archive {name}.crate ({spec["archiveSha256"]}) in Cargo cache; fetch pinned crate first. No registry files will be edited.')
    OUTPUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="prepare-", dir=OUTPUT) as temporary:
        staging = Path(temporary)
        with tarfile.open(archives[0], "r:gz") as archive:
            archive.extractall(staging, filter="data")
        source = staging / name
        for edit in spec["edits"]:
            file = source / edit["path"]
            contents = file.read_text()
            if contents.count(edit["old"]) != edit.get("count", 1):
                raise RuntimeError(f'Exact patch preimage mismatch: {edit["path"]}')
            file.write_text(contents.replace(edit["old"], edit["new"]))
        marker = {"spec": sha(raw), "archive": spec["archiveSha256"],
                  "files": {str(file.relative_to(source)): sha(file.read_bytes())
                            for file in sorted(source.rglob("*")) if file.is_file()}}
        (source / ".fixture-patch.json").write_text(json.dumps(marker, indent=2) + "\n")
        if destination.exists():
            if not marker_path.exists():
                raise RuntimeError(f'Unowned directory: {destination}')
            shutil.rmtree(destination)
        source.rename(destination)
    print(f'Prepared {name}: {len(spec["edits"])} exact edits; original archive SHA-256 verified', flush=True)


for specification in sorted(PATCHES.glob("*.json")):
    prepare(specification)
