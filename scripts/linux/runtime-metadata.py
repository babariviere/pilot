#!/usr/bin/env python3
"""Audit every shipped ELF, not only already-loaded addons. No distribution-name gates."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def links(root):
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                if path.readlink().is_absolute() or not path.resolve(strict=True).is_relative_to(root):
                    raise ValueError(f"Non-relocatable runtime link: {path}")


def prepare(root):
    # Never follow workspace links or delete native build/Release/*.node.
    import shutil
    for directory, dirs, files in os.walk(root, followlinks=False):
        if Path(directory).name == "prebuilds":
            for name in list(dirs):
                if name != "linux-x64":
                    shutil.rmtree(Path(directory) / name)
                    dirs.remove(name)
        for name in files:
            if name.endswith((".map", ".d.ts", ".d.mts", ".d.cts")):
                path = Path(directory) / name
                if not path.is_symlink():
                    path.unlink()
    links(root)


def audit(root):
    links(root)
    binaries = []
    glibc = (0, 0)
    glibcxx = (0, 0, 0)
    for directory, _, files in os.walk(root, followlinks=False):
        for name in files:
            path = Path(directory) / name
            if path.is_symlink():
                continue
            with path.open("rb") as handle:
                header = handle.read(20)
            if header[:4] != b"\x7fELF":
                continue
            if header[4:6] != b"\x02\x01" or int.from_bytes(header[18:20], "little") != 62:
                raise ValueError(f"Not little-endian ELF64 x86-64: {path}")
            dynamic = subprocess.run(["readelf", "-d", str(path)], check=True, capture_output=True, text=True).stdout
            for entry in re.findall(r"\((?:RPATH|RUNPATH)\).*?\[(.*?)\]", dynamic):
                for part in entry.split(":"):
                    if part != "$ORIGIN" and not part.startswith("$ORIGIN/"):
                        raise ValueError(f"Non-relative runtime search path: {path}: {entry}")
                    if not (path.parent / part.removeprefix("$ORIGIN").removeprefix("/")).resolve().is_relative_to(root):
                        raise ValueError(f"Runtime search path escapes package: {path}: {entry}")
            versions = subprocess.run(["readelf", "-V", str(path)], check=True, capture_output=True, text=True).stdout
            needed = [tuple(map(int, v.split("."))) for v in re.findall(r"\bGLIBC_([0-9]+\.[0-9]+)\b", versions)]
            glibc = max([glibc] + needed)
            cpp_needed = [tuple(map(int, v.split("."))) for v in re.findall(r"\bGLIBCXX_([0-9]+\.[0-9]+\.[0-9]+)\b", versions)]
            glibcxx = max([glibcxx] + cpp_needed)
            dependency = subprocess.run(["ldd", str(path)], capture_output=True, text=True)
            output = dependency.stdout + dependency.stderr
            if "not found" in output or (dependency.returncode and not re.search(r"statically linked|not a dynamic executable", output)):
                raise ValueError(f"Unresolved runtime libraries: {path}: {output}")
            binaries.append(str(path.relative_to(root)))
    if not binaries or "node/bin/node" not in binaries or not any(p.endswith("pty.node") for p in binaries):
        raise ValueError("Node or target-ABI PTY addon missing")
    # An ABI compatibility bound, not a distro support matrix. Catch accidental newer-toolchain builds.
    if glibc > (2, 34):
        raise ValueError(f"Runtime requires glibc {glibc}, exceeding packaging ABI ceiling 2.34")
    if glibcxx > (3, 4, 25):
        raise ValueError(f"Runtime requires libstdc++ {glibcxx}, exceeding packaging ABI ceiling GLIBCXX_3.4.25")
    report = {"minimumGlibc": ".".join(map(str, glibc)), "minimumGlibcxx": ".".join(map(str, glibcxx)), "elfFiles": sorted(binaries)}
    (root / "runtime-abi.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    {"prepare": prepare, "audit": audit}[sys.argv[1]](Path(sys.argv[2]).resolve())
