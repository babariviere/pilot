#!/usr/bin/env python3
"""Relocatable Linux GUI candidate assembly. No install, daemon launch or updater."""
import argparse
import platform
from pathlib import Path
import re
import shutil
import subprocess
import sys

from bundle_runtime import digest, inventory, read_json, source, write_json

TARGET = "x86_64-unknown-linux-gnu"
MANIFEST = "linux-gui-package.json"
BINARIES = ("pilot-desktop", "pilot-visual-worker")
REQUIRED = (
    "node/bin/node", "node/LICENSE", "package.json", "pnpm-lock.yaml",
    "packages/daemon/src/main.ts", "packages/daemon/src/runtime-launch.ts",
    "packages/daemon/src/runtime-owner.ts", "packages/kernel/src/worker-entry.ts",
    "packages/protocol/src/hello.ts", "packages/kernel/skills/pilot-artifacts/SKILL.md",
    "packages/daemon/src/usage-history-worker.mjs",
    "packages/artifacts/dist/libraries/manifest.json",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
    "node_modules/@earendil-works/pi-durable/package.json",
    "node_modules/node-pty/package.json", "node_modules/ws/package.json",
)
LAUNCHER = '''#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Never silently enter fixture mode or launch an unqualified bundled daemon.
if [ "$#" -eq 0 ]; then set -- --bundled; fi
exec "$root/libexec/pilot-desktop" "$@"
'''


def native_host():
    if sys.platform != "linux" or platform.machine() != "x86_64":
        raise ValueError("Native Linux x86_64 qualification required, not emulated/macOS proof")


def elf_closure(root):
    """Inspect every ELF and resolve dependencies on this qualification host only."""
    native_host()
    root = root.resolve(strict=True)
    result = []
    for item in inventory(root):
        if item["kind"] != "file":
            continue
        path = root / item["path"]
        with path.open("rb") as stream:
            header = stream.read(20)
        if header[:4] != b"\x7fELF":
            continue
        if header[4:6] != b"\x02\x01" or int.from_bytes(header[18:20], "little") != 62:
            raise ValueError("Wrong ELF architecture: " + item["path"])
        dynamic = subprocess.check_output(["readelf", "-d", str(path)], text=True, timeout=30)
        needed = re.findall(r"\(NEEDED\).*?\[(.*?)\]", dynamic)
        if any("/" in name for name in needed):
            raise ValueError("Absolute native dependency")
        for search in re.findall(r"\((?:RPATH|RUNPATH)\).*?\[(.*?)\]", dynamic):
            for part in search.split(":"):
                if part != "$ORIGIN" and not part.startswith("$ORIGIN/"):
                    raise ValueError("Nonrelocatable library search path")
                if not (path.parent / part.removeprefix("$ORIGIN").removeprefix("/")).resolve().is_relative_to(root):
                    raise ValueError("Library search path escapes package")
        linked = subprocess.run(["ldd", str(path)], capture_output=True, text=True, timeout=30)
        output = linked.stdout + linked.stderr
        if "not found" in output or (linked.returncode and not re.search(r"statically linked|not a dynamic executable", output)):
            raise ValueError("Unresolved dependencies: " + item["path"] + ": " + output)
        versions = subprocess.check_output(["readelf", "-V", str(path)], text=True, timeout=30)
        result.append(dict(path=item["path"], needed=needed, resolved=output,
                           symbol_versions=sorted(set(re.findall(r"\b(?:GLIBC|GLIBCXX)_[0-9.]+", versions)))))
    return result


def runtime_identity(runtime, expected):
    build = read_json(runtime / "runtime-build.json", 4096)
    if (build.get("schema") != 1 or build.get("source") != source(expected)
            or build.get("platform") != "linux" or build.get("arch") != "x64"
            or build.get("protocol") != 1 or not re.fullmatch(r"24\.\d+\.\d+", build.get("node", ""))
            or build.get("version") != read_json(runtime / "package.json")["version"]):
        raise ValueError("Runtime identity mismatch")
    for name in REQUIRED:
        if not (runtime / name).is_file():
            raise ValueError("Missing runtime resource: " + name)
    return build


def assemble(runtime, executables, runtime_receipt, output, expected):
    source(expected)
    if output.exists() or output.is_symlink():
        raise ValueError("Output must be fresh")
    # Reuse the macOS packaging seam's bounded inventory and identity conventions,
    # not its Mach-O signing, Contents layout or automatic-start assumptions.
    files = inventory(runtime)
    build = runtime_identity(runtime, expected)
    proof = read_json(runtime_receipt)
    if (proof.get("source") != expected or proof.get("target") != TARGET or proof.get("files") != files):
        raise ValueError("Immutable runtime receipt mismatch")
    receipt = read_json(executables / "manifest.json")
    if receipt.get("tested_sha") != expected or receipt.get("target") != TARGET:
        raise ValueError("Executable source/target mismatch")
    inventory(executables)
    for name in BINARIES:
        entries = [item for item in receipt.get("binaries", []) if item.get("name") == name]
        path = executables / name
        if (len(entries) != 1 or not path.is_file() or path.is_symlink()
                or entries[0].get("sha256") != digest(path) or entries[0].get("bytes") != path.stat().st_size):
            raise ValueError("Executable hash mismatch: " + name)
    output.mkdir(mode=0o755)
    try:
        (output / "bin").mkdir()
        (output / "libexec").mkdir()
        for name in BINARIES:
            shutil.copyfile(executables / name, output / "libexec" / name)
            (output / "libexec" / name).chmod(0o755)
        shutil.copytree(runtime, output / "runtime", symlinks=True)
        (output / "bin/pilot-next").write_text(LAUNCHER)
        (output / "bin/pilot-next").chmod(0o755)
        write_json(output / "rust-inputs.json", receipt)
        write_json(output / "runtime-inputs.json", proof)
        write_json(output / MANIFEST, dict(schema=1, kind="unqualified-linux-gui-candidate",
                   source=expected, target=TARGET, build=build, bundled_launch=False,
                   installer=False, updater=False, native_visual_execution=False, files=inventory(output)))
        verify(output)
    except BaseException:
        shutil.rmtree(output)
        raise


def verify(output):
    value = read_json(output / MANIFEST)
    actual = [item for item in inventory(output) if item["path"] != MANIFEST]
    if (value.get("schema") != 1 or value.get("kind") != "unqualified-linux-gui-candidate"
            or value.get("target") != TARGET or value.get("files") != actual
            or any(value.get(key) is not False for key in ("bundled_launch", "installer", "updater", "native_visual_execution"))):
        raise ValueError("Package inventory/policy mismatch")
    if runtime_identity(output / "runtime", value["source"]) != value["build"]:
        raise ValueError("Package runtime identity mismatch")
    proof = read_json(output / "runtime-inputs.json")
    if (proof.get("source") != value["source"] or proof.get("target") != TARGET
            or proof.get("files") != inventory(output / "runtime")):
        raise ValueError("Copied runtime differs from immutable input receipt")
    receipt = read_json(output / "rust-inputs.json")
    if receipt.get("tested_sha") != value["source"] or receipt.get("target") != TARGET:
        raise ValueError("Copied executable source/target mismatch")
    for name in BINARIES:
        matches = [entry for entry in receipt.get("binaries", []) if entry.get("name") == name]
        path = output / "libexec" / name
        if len(matches) != 1 or matches[0].get("sha256") != digest(path) or matches[0].get("bytes") != path.stat().st_size:
            raise ValueError("Copied executable differs from immutable input receipt")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    build = commands.add_parser("assemble")
    for name in ("runtime", "executables", "runtime-receipt", "output"):
        build.add_argument("--" + name, type=Path, required=True)
    build.add_argument("--source", required=True)
    for name in ("verify", "dependencies"):
        commands.add_parser(name).add_argument("output", type=Path)
    args = parser.parse_args()
    if args.action == "assemble":
        assemble(args.runtime.resolve(), args.executables.resolve(), args.runtime_receipt,
                 args.output.absolute(), args.source)
    elif args.action == "verify":
        verify(args.output.resolve())
    else:
        import json
        verify(args.output.resolve())
        print(json.dumps(elf_closure(args.output.resolve()), indent=2))


if __name__ == "__main__":
    main()
