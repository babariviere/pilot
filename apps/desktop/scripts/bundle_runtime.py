#!/usr/bin/env python3
"""Immutable macOS runtime staging and ad-hoc development app bundles, never installation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[3]
APP_ID = "com.babariviere.pilot-next"
CAP_FILES = 30_000
CAP_BYTES = 2 * 1024**3
MANIFEST = "Contents/Resources/bundled-runtime.json"
REQUIRED = [
    "node/bin/node", "node/LICENSE", "package.json", "pnpm-lock.yaml",
    "packages/daemon/src/main.ts", "packages/daemon/src/runtime-launch.ts",
    "packages/daemon/src/runtime-owner.ts", "packages/kernel/src/worker-entry.ts",
    "packages/protocol/src/hello.ts", "packages/kernel/skills/pilot-artifacts/SKILL.md",
    "packages/daemon/src/usage-history-worker.mjs", "packages/artifacts/dist/libraries/manifest.json",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
    "node_modules/@earendil-works/pi-durable/package.json",
    "node_modules/node-pty/package.json", "node_modules/ws/package.json",
    "runtime-build.json",
    "desktop-assets/AppIcon.icns",
]


def run(*args, cwd=None, env=None, timeout=30):
    return subprocess.check_output(args, cwd=cwd, env=env, timeout=timeout, text=True).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source(value):
    if not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("Expected a full immutable source commit")
    return value


def read_json(path, cap=8 * 1024**2):
    with path.open("rb") as stream:
        raw = stream.read(cap + 1)
    if len(raw) > cap:
        raise ValueError("Manifest exceeds its bound")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate manifest key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")


def inventory(root):
    """Bound the entire closure, including relative symlinks. Never traverse directory links."""
    result, total = [], 0
    root = root.resolve(strict=True)
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            info = path.lstat()
            if not path.is_symlink() and info.st_mode & 0o6022:
                raise ValueError(f"Unsafe bundle permissions: {relative}")
            mode = stat.S_IMODE(info.st_mode)
            if path.is_symlink():
                target = os.readlink(path)
                if os.path.isabs(target) or not path.resolve(strict=True).is_relative_to(root):
                    raise ValueError(f"Runtime link escapes bundle: {relative}")
                item = dict(path=relative, kind="link", target=target)
            elif path.is_dir():
                item = dict(path=relative, kind="directory", mode=mode)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                total += info.st_size
                if info.st_size > 256 * 1024**2 or total > CAP_BYTES:
                    raise ValueError("Runtime exceeds expanded byte policy")
                item = dict(path=relative, kind="file", bytes=info.st_size, mode=mode, sha256=digest(path))
            else:
                raise ValueError(f"Unsupported bundle object: {relative}")
            result.append(item)
            if len(result) > CAP_FILES:
                raise ValueError("Bundle exceeds entry policy")
    return sorted(result, key=lambda item: item["path"])


def supports_macos_15(load_commands):
    versions = []
    for block in re.split(r"Load command \d+\s*\n", load_commands)[1:]:
        if re.search(r"\bcmd LC_BUILD_VERSION\b", block):
            if not re.search(r"\bplatform (?:1|MACOS)\s*\n", block):
                return False
            field = "minos"
        elif re.search(r"\bcmd LC_VERSION_MIN_MACOSX\b", block):
            field = "version"
        else:
            continue
        match = re.search(rf"\b{field} (\d+(?:\.\d+){{0,2}})\s*\n", block)
        if not match:
            return False
        value = tuple(map(int, match[1].split(".")))
        versions.append(value + (0,) * (3 - len(value)))
    return bool(versions) and all(v <= (15, 0, 0) for v in versions)


def native_closure(root):
    if sys.platform != "darwin" or run("/usr/bin/uname", "-m") != "arm64":
        raise ValueError("App bundles require native arm64 macOS verification")
    root = root.resolve()
    binaries = []
    required = {
        "Contents/MacOS/pilot-desktop", "Contents/MacOS/pilot-visual-worker",
        "Contents/Helpers/pilot-desktop-update-helper",
        "Contents/Resources/runtime/node/bin/node", "Contents/Helpers/PilotPower",
        "Contents/Helpers/PilotSystemEvents.app/Contents/MacOS/PilotSystemEvents",
    }
    for item in inventory(root):
        if item["kind"] != "file":
            continue
        path = root / item["path"]
        with path.open("rb") as stream:
            magic = stream.read(4)
        if magic not in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
            if item["path"] in required:
                raise ValueError(f"Required executable is not Mach-O: {item['path']}")
            continue
        if run("/usr/bin/lipo", "-archs", str(path)) != "arm64":
            raise ValueError(f"Non-arm64 Mach-O: {item['path']}")
        if any(ord(c) < 32 for c in str(path)) or not supports_macos_15(run("/usr/bin/otool", "-l", str(path))):
            raise ValueError(f"Unverified macOS 15 deployment metadata: {item['path']}")
        for line in run("/usr/bin/otool", "-L", str(path)).splitlines()[1:]:
            dependency = line.strip().split(" (", 1)[0]
            if dependency.startswith(("/usr/lib/", "/System/Library/")):
                continue
            if dependency.startswith("@loader_path/"):
                target = (path.parent / dependency.removeprefix("@loader_path/")).resolve(strict=True)
                if target.is_relative_to(root):
                    continue
            # No unexplained @rpath or absolute Homebrew/checkout escape is admitted.
            raise ValueError(f"Unresolved native dependency: {dependency}")
        binaries.append(path)
    return binaries


def validate_runtime(runtime, expected_source):
    build = read_json(runtime / "runtime-build.json", 4096)
    if (build.get("schema") != 1 or build.get("source") != source(expected_source)
            or build.get("platform") != "darwin" or build.get("arch") != "arm64"
            or build.get("protocol") != 1 or not re.fullmatch(r"24\.\d+\.\d+", build.get("node", ""))
            or build.get("version") != read_json(runtime / "package.json")["version"]):
        raise ValueError("Runtime build identity mismatch")
    for relative in REQUIRED:
        if not (runtime / relative).is_file():
            raise ValueError(f"Required runtime resource missing: {relative}")
    return build


def receipt(directory, expected_source, names):
    value = read_json(directory / "manifest.json")
    if value.get("tested_sha", value.get("source")) != source(expected_source) or value.get("target") != "aarch64-apple-darwin":
        raise ValueError("Executable receipt source/target mismatch")
    entries = value.get("binaries", [])
    for name in names:
        matches = [entry for entry in entries if entry.get("name") == name]
        path = directory / name
        if len(matches) != 1 or not path.is_file() or digest(path) != matches[0].get("sha256") or path.stat().st_size != matches[0].get("bytes"):
            raise ValueError(f"Executable receipt mismatch: {name}")


def assemble(runtime, executables, native, output, expected_source, updater=None, bundle_build=None, accepted_capsules=()):
    if output.exists() or output.is_symlink() or output.name != "Pilot Next.app":
        raise ValueError("Use a fresh output named Pilot Next.app")
    build = validate_runtime(runtime, expected_source)
    bundle_build = bundle_build or build["version"]
    if not re.fullmatch(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,3}", bundle_build):
        raise ValueError("Bundle build must be 1-4 bounded numeric components")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", build["version"]):
        raise ValueError("Bundle short version must be numeric")
    if len(accepted_capsules) > 4 or len(set(accepted_capsules)) != len(accepted_capsules) or any(not re.fullmatch(r"[0-9a-f]{64}", v) for v in accepted_capsules):
        raise ValueError("Runtime compatibility must list exact bounded capsule identities")
    receipt(executables, expected_source, ["pilot-desktop", "pilot-visual-worker"])
    updater = updater or executables
    receipt(updater, expected_source, ["pilot-desktop-update-helper"])
    app_config = read_json(executables / "manifest.json").get("updater_configuration")
    helper_config = read_json(updater / "manifest.json").get("updater_configuration")
    if app_config != helper_config:
        raise ValueError("App/helper updater configuration receipts differ")
    if app_config != dict(schema=1, mode="unconfigured"):
        raise ValueError("Development assembly requires explicit unconfigured app/helper input receipts")
    receipt(native, expected_source, ["PilotPower", "PilotSystemEvents"])
    inventory(runtime)  # Admission before any recursive copy can follow external input.
    output.mkdir(mode=0o755)
    try:
        contents = output / "Contents"
        contents.mkdir()
        (contents / "MacOS").mkdir()
        (contents / "Helpers").mkdir()
        (contents / "Resources").mkdir()
        shutil.copyfile(updater / "pilot-desktop-update-helper", contents / "Helpers/pilot-desktop-update-helper")
        (contents / "Helpers/pilot-desktop-update-helper").chmod(0o755)
        for name in ("pilot-desktop", "pilot-visual-worker"):
            shutil.copyfile(executables / name, contents / "MacOS" / name)
            (contents / "MacOS" / name).chmod(0o755)
        shutil.copytree(runtime, contents / "Resources/runtime", symlinks=True)
        shutil.copyfile(runtime / "desktop-assets/AppIcon.icns", contents / "Resources/AppIcon.icns")
        for name, directory in (("rust-inputs.json", executables), ("native-inputs.json", native)):
            value = read_json(directory / "manifest.json")
            write_json(contents / "Resources" / name, dict(schema=1, source=expected_source, binaries=value["binaries"]))
        write_json(contents / "Resources/updater-inputs.json", dict(schema=1, source=expected_source,
                   binaries=read_json(updater / "manifest.json")["binaries"], configuration=helper_config))
        write_json(contents / "Resources/update-runtime-policy.json", dict(schema=1, accepted_capsules=list(accepted_capsules)))
        shutil.copyfile(native / "PilotPower", contents / "Helpers/PilotPower")
        (contents / "Helpers/PilotPower").chmod(0o755)
        helper = contents / "Helpers/PilotSystemEvents.app/Contents"
        (helper / "MacOS").mkdir(parents=True)
        shutil.copyfile(native / "PilotSystemEvents", helper / "MacOS/PilotSystemEvents")
        (helper / "MacOS/PilotSystemEvents").chmod(0o755)
        with (helper / "Info.plist").open("wb") as stream:
            plistlib.dump(dict(CFBundleIdentifier=APP_ID + ".system-events", CFBundleName="Pilot Next System Events",
                               CFBundleExecutable="PilotSystemEvents", CFBundlePackageType="APPL", CFBundleVersion="1",
                               LSUIElement=True, LSMinimumSystemVersion="15.0"), stream)
        with (contents / "Info.plist").open("wb") as stream:
            plistlib.dump(dict(CFBundleIdentifier=APP_ID, CFBundleName="Pilot Next", CFBundleDisplayName="Pilot Next",
                               CFBundleExecutable="pilot-desktop", CFBundlePackageType="APPL", CFBundleVersion=bundle_build,
                               CFBundleShortVersionString=build["version"], CFBundleIconFile="AppIcon", LSMinimumSystemVersion="15.0", NSHighResolutionCapable=True), stream)
        # Only ad-hoc development signing, never access a signing key or alter a production identity.
        for binary in native_closure(output):
            # Signing the bundle's main executable by its file path can also
            # create the enclosing app resource seal. Seal that only at the end.
            if binary != (contents / "MacOS/pilot-desktop").resolve():
                run("/usr/bin/codesign", "--force", "--sign", "-", str(binary))
        run("/usr/bin/codesign", "--force", "--sign", "-", str(helper.parent))
        # The main executable's outer signature seals resources and cannot hash itself.
        payload = [item for item in inventory(output) if item["path"] != "Contents/MacOS/pilot-desktop"
                   and not item["path"].startswith("Contents/_CodeSignature")]
        write_json(output / MANIFEST, dict(schema=1, kind="development-bundled-runtime", build=build, files=payload))
        run("/usr/bin/codesign", "--force", "--sign", "-", str(output))
        run("/usr/bin/codesign", "--verify", "--deep", "--strict", str(output))
        verify(output)
    except BaseException:
        shutil.rmtree(output)  # Only our fresh, never-installed staging directory.
        raise


def verify(output):
    value = read_json(output / MANIFEST)
    actual = [item for item in inventory(output) if item["path"] not in (MANIFEST, "Contents/MacOS/pilot-desktop")
              and not item["path"].startswith("Contents/_CodeSignature")]
    if value.get("schema") != 1 or value.get("kind") != "development-bundled-runtime" or value.get("files") != actual:
        expected = {item["path"]: item for item in value.get("files", [])}
        observed = {item["path"]: item for item in actual}
        changed = [name for name in sorted(expected.keys() | observed.keys()) if expected.get(name) != observed.get(name)]
        raise ValueError("Bundle inventory/hash mismatch: " + ", ".join(changed[:4]))
    if validate_runtime(output / "Contents/Resources/runtime", value["build"]["source"]) != value["build"]:
        raise ValueError("Runtime manifest/build identity mismatch")


def snapshot_build(expected_source, output, native=False):
    source(expected_source)
    if sys.platform != "darwin" or run("/usr/bin/uname", "-m") != "arm64":
        raise ValueError("Runtime/helper staging requires native arm64 macOS")
    if run("git", "cat-file", "-t", expected_source, cwd=ROOT) != "commit":
        raise ValueError("Runtime source must identify a commit, not a tree or tag")
    if output.exists() or output.is_symlink():
        raise ValueError("Staging output must not already exist")
    with tempfile.TemporaryDirectory(prefix="next-runtime-source-") as temporary:
        temporary = Path(temporary)
        archive, checkout = temporary / "source.tar", temporary / "source"
        checkout.mkdir()
        with archive.open("wb") as stream:
            subprocess.run(["git", "archive", "--format=tar", expected_source], cwd=ROOT, stdout=stream, check=True, timeout=60)
        with tarfile.open(archive) as tar:
            tar.extractall(checkout, filter="data")
        if native:
            for product in ("PilotPower", "PilotSystemEvents"):
                subprocess.run(["/bin/bash", str(checkout / "apps/macos/scripts/build.sh"), "-c", "release", "--product", product], check=True, timeout=1200)
            paths = list((checkout / "apps/macos/.build").glob("*/release/PilotPower"))
            if len(paths) != 1:
                raise ValueError("Native helper output is ambiguous")
            output.mkdir()
            binaries = []
            for name in ("PilotPower", "PilotSystemEvents"):
                shutil.copyfile(paths[0].parent / name, output / name)
                (output / name).chmod(0o755)
                binaries.append(dict(name=name, bytes=(output / name).stat().st_size, sha256=digest(output / name)))
            write_json(output / "manifest.json", dict(schema=1, source=expected_source, target="aarch64-apple-darwin", binaries=binaries))
        else:
            # Same production workspace closure as Swift, from git objects, never live node_modules.
            env = {key: value for key, value in os.environ.items() if not key.startswith(("PILOT_", "PI_", "NODE_"))}
            env["HOME"] = str(temporary / "home")
            Path(env["HOME"]).mkdir()
            env["XDG_CONFIG_HOME"] = str(temporary / "config")
            env["XDG_DATA_HOME"] = str(temporary / "data")
            subprocess.run(["/bin/bash", str(checkout / "apps/macos/scripts/bundle-runtime.sh"), str(output)], env=env, check=True, timeout=1200)
            (output / "desktop-assets").mkdir()
            subprocess.run([sys.executable, str(checkout / "apps/desktop/scripts/make_dev_icon.py"),
                            str(output / "desktop-assets/AppIcon.icns")], check=True, timeout=10)
            version = read_json(checkout / "package.json")["version"]
            node = run(str(output / "node/bin/node"), "--version").removeprefix("v")
            write_json(output / "runtime-build.json", dict(schema=1, source=expected_source, version=version, protocol=1, platform="darwin", arch="arm64", node=node))
            validate_runtime(output, expected_source)


def snapshot_rust(expected_source, output):
    """Build all three Rust inputs from immutable objects, unconfigured and non-release only."""
    source(expected_source)
    if sys.platform != "darwin" or run("/usr/bin/uname", "-m") != "arm64":
        raise ValueError("Rust bundle inputs require native arm64 macOS")
    if output.exists() or output.is_symlink():
        raise ValueError("Rust input output must be fresh")
    if run("git", "cat-file", "-t", expected_source, cwd=ROOT) != "commit":
        raise ValueError("Rust input source must identify a commit")
    tools = ROOT / "apps/desktop/.tools"
    if not (tools / "bin/mbx").is_file() or not (tools / "rustup").is_dir():
        raise ValueError("Bootstrap the pinned build-host Rust tools first")
    with tempfile.TemporaryDirectory(prefix="next-rust-input-source-") as temporary:
        temporary = Path(temporary)
        checkout, archive = temporary / "source", temporary / "source.tar"
        checkout.mkdir()
        with archive.open("wb") as stream:
            subprocess.run(["git", "archive", "--format=tar", expected_source], cwd=ROOT, stdout=stream, check=True, timeout=60)
        with tarfile.open(archive) as tar:
            tar.extractall(checkout, filter="data")
        desktop = checkout / "apps/desktop"
        (desktop / ".tools/bin").mkdir(parents=True)
        (desktop / ".tools/bin/mbx").symlink_to((tools / "bin/mbx").resolve(strict=True))
        (desktop / ".tools/rustup").symlink_to((tools / "rustup").resolve(strict=True), target_is_directory=True)
        env = {key: value for key, value in os.environ.items() if not key.startswith(("PILOT_", "PI_", "NODE_"))}
        # No trust/feed/public-key variables are inherited. This lane cannot
        # become a production release or configured updater by ambient state.
        subprocess.run([sys.executable, str(desktop / "scripts/prepare-visual-worker.py")], env=env, check=True, timeout=120)
        slot = str(ROOT / "scripts/verification-slot.py")
        cargo = str(desktop / "scripts/cargo.sh")
        for command in (["build", "--locked", "-p", "pilot-desktop", "-p", "pilot-visual-worker"],
                        ["build", "--manifest-path", "updater/Cargo.toml", "--locked", "--features", "native-macos", "--bin", "pilot-desktop-update-helper"]):
            subprocess.run([sys.executable, slot, "swift", "--", "/bin/bash", cargo, *command], cwd=checkout, env=env, check=True, timeout=1200)
        paths = [desktop / "target/dev/debug" / name for name in
                 ("pilot-desktop", "pilot-visual-worker", "pilot-desktop-update-helper")]
        for path in paths:
            if run("/usr/bin/lipo", "-archs", str(path)) != "arm64":
                raise ValueError("Rust input architecture mismatch")
        output.mkdir(mode=0o700)
        binaries = []
        for path in paths:
            shutil.copyfile(path, output / path.name)
            (output / path.name).chmod(0o755)
            binaries.append(dict(name=path.name, bytes=path.stat().st_size, sha256=digest(path)))
        write_json(output / "manifest.json", dict(schema=1, kind="development-rust-inputs", source=expected_source,
                   target="aarch64-apple-darwin", deployment_target="15.0", profile="dev", installable_update=False,
                   updater_configuration=dict(schema=1, mode="unconfigured"), binaries=binaries))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for name in ("runtime", "native", "rust"):
        command = commands.add_parser(name)
        command.add_argument("--source", required=True)
        command.add_argument("--output", type=Path, required=True)
    bundle = commands.add_parser("bundle")
    for name in ("runtime", "executables", "native", "output"):
        bundle.add_argument("--" + name, type=Path, required=True)
    bundle.add_argument("--source", required=True)
    bundle.add_argument("--updater", type=Path)
    bundle.add_argument("--bundle-build")
    bundle.add_argument("--accepted-capsule", action="append", default=[])
    check = commands.add_parser("verify")
    check.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.action == "rust":
        snapshot_rust(args.source, args.output.absolute())
    elif args.action in ("runtime", "native"):
        snapshot_build(args.source, args.output.absolute(), args.action == "native")
    elif args.action == "bundle":
        assemble(args.runtime, args.executables, args.native, args.output, args.source, args.updater, args.bundle_build, args.accepted_capsule)
    else:
        verify(args.output)


if __name__ == "__main__":
    main()
