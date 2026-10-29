#!/usr/bin/env python3
"""Relocatable Linux GUI candidate assembly. No install, daemon launch or updater."""
import argparse
import base64
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


def power_identity(runtime, expected):
    helper = runtime / "bin/PilotPower"
    proof = read_json(runtime / "power-inputs.json")
    if (proof.get("source") != expected or proof.get("target") != TARGET
            or proof.get("qualification") != "unqualified"
            or helper.is_symlink() or not helper.is_file() or not helper.stat().st_mode & 0o111
            or proof.get("sha256") != digest(helper) or proof.get("bytes") != helper.stat().st_size):
        raise ValueError("Power helper source/target/hash mismatch")


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
    power_identity(runtime, expected)
    return build


def assemble(runtime, executables, runtime_receipt, output, expected, updater=None, bundle_build=None, application_id=None, accepted_capsules=()):
    source(expected)
    production = updater is not None
    if production:
        if (not bundle_build or not re.fullmatch(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,3}", bundle_build)
                or not application_id or application_id == "com.babariviere.pilot"
                or not re.fullmatch(r"[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+", application_id)
                or output.name != "Pilot Next"
                or any(not re.fullmatch(r"[0-9a-f]{64}", item) for item in accepted_capsules)):
            raise ValueError("Linux update identity/policy is invalid")
        receipt = read_json(updater / "manifest.json")
        helper = updater / "pilot-desktop-update-helper"
        matches = [entry for entry in receipt.get("binaries", []) if entry.get("name") == helper.name]
        if (receipt.get("tested_sha") != expected or receipt.get("target") != TARGET or len(matches) != 1
                or not helper.is_file() or helper.is_symlink() or matches[0].get("sha256") != digest(helper)
                or matches[0].get("bytes") != helper.stat().st_size):
            raise ValueError("Updater source/target/hash mismatch")
    elif bundle_build or application_id or accepted_capsules:
        raise ValueError("Production update options require updater inputs")
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
    if production:
        config = receipt.get("updater_configuration")
        helper_config = read_json(updater / "manifest.json").get("updater_configuration")
        if (not isinstance(config, dict) or config != helper_config or config.get("schema") != 1
                or config.get("mode") != "configured" or config.get("build") != bundle_build
                or config.get("application_id") != application_id
                or config.get("code_requirement") != "signed-linux-inventory-v1"
                or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", config.get("repository", ""))
                or len(base64.b64decode(config.get("public_key", ""), validate=True)) != 32):
            raise ValueError("GUI/helper compiled update configuration mismatch")
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
        if production:
            shutil.copyfile(updater / "pilot-desktop-update-helper", output / "libexec/pilot-desktop-update-helper")
            (output / "libexec/pilot-desktop-update-helper").chmod(0o755)
            write_json(output / "updater-inputs.json", read_json(updater / "manifest.json"))
            write_json(output / "update-runtime-policy.json", dict(schema=1, accepted_capsules=list(accepted_capsules)))
        shutil.copytree(runtime, output / "runtime", symlinks=True)
        (output / "bin/pilot-next").write_text(LAUNCHER)
        (output / "bin/pilot-next").chmod(0o755)
        write_json(output / "rust-inputs.json", receipt)
        write_json(output / "runtime-inputs.json", proof)
        write_json(output / MANIFEST, dict(schema=1, kind="linux-gui-distribution" if production else "unqualified-linux-gui-candidate",
                   source=expected, target=TARGET, build=build, bundled_launch=production,
                   installer=production, updater=production, native_visual_execution=False, files=inventory(output),
                   **(dict(bundle_build=bundle_build, application_id=application_id, short_version=build["version"]) if production else {})))
        verify(output)
    except BaseException:
        shutil.rmtree(output)
        raise


def verify(output):
    value = read_json(output / MANIFEST)
    actual = [item for item in inventory(output) if item["path"] not in (MANIFEST, "linux-gui-package.sig")]
    production = value.get("kind") == "linux-gui-distribution"
    if (value.get("schema") != 1 or value.get("kind") not in ("unqualified-linux-gui-candidate", "linux-gui-distribution")
            or value.get("target") != TARGET or value.get("files") != actual
            or value.get("native_visual_execution") is not False
            or any(value.get(key) is not production for key in ("bundled_launch", "installer", "updater"))):
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
    if production:
        helper_receipt = read_json(output / "updater-inputs.json")
        helper = output / "libexec/pilot-desktop-update-helper"
        entries = [item for item in helper_receipt.get("binaries", []) if item.get("name") == helper.name]
        if (helper_receipt.get("tested_sha") != value["source"] or helper_receipt.get("target") != TARGET
                or len(entries) != 1 or entries[0].get("sha256") != digest(helper)
                or entries[0].get("bytes") != helper.stat().st_size
                or not re.fullmatch(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,3}", value.get("bundle_build", ""))
                or value.get("short_version") != value["build"]["version"]
                or not value.get("application_id") or value["application_id"] == "com.babariviere.pilot"):
            raise ValueError("Copied updater/identity differs from immutable input receipt")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    build = commands.add_parser("assemble")
    for name in ("runtime", "executables", "runtime-receipt", "output"):
        build.add_argument("--" + name, type=Path, required=True)
    build.add_argument("--source", required=True)
    build.add_argument("--updater", type=Path)
    build.add_argument("--bundle-build")
    build.add_argument("--application-id")
    build.add_argument("--accepted-capsule", action="append", default=[])
    for name in ("verify", "dependencies"):
        commands.add_parser(name).add_argument("output", type=Path)
    args = parser.parse_args()
    if args.action == "assemble":
        assemble(args.runtime.resolve(), args.executables.resolve(), args.runtime_receipt,
                 args.output.absolute(), args.source, args.updater, args.bundle_build, args.application_id, args.accepted_capsule)
    elif args.action == "verify":
        verify(args.output.resolve())
    else:
        import json
        verify(args.output.resolve())
        print(json.dumps(elf_closure(args.output.resolve()), indent=2))


if __name__ == "__main__":
    main()
