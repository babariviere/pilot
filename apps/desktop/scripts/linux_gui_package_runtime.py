#!/usr/bin/env python3
"""Immutable Linux GUI runtime input producer, private source/fixture builds only."""
import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time

import linux_gui_package as package
from bundle_runtime import CAP_BYTES, CAP_FILES

ROOT = Path(__file__).resolve().parents[3]


def stage_power(checkout, runtime, expected, env):
    """Build only the archived Rust helper; receipt enters the runtime inventory."""
    toolchain = ROOT / "apps/desktop/.tools/rustup/toolchains/1.98.1-x86_64-unknown-linux-gnu/bin"
    if not all((toolchain / name).is_file() for name in ("cargo", "rustc")):
        raise ValueError("Bootstrap pinned Rust tools before Linux power packaging")
    # The ABI container has no rustup shims or host home, and CI bootstrap omits mbx.
    # Use that same pinned toolchain directly, with private writable Cargo state.
    build_env = dict(env, PATH=str(toolchain) + os.pathsep + env.get("PATH", "/usr/bin:/bin"),
                     RUSTC=str(toolchain / "rustc"), CARGO_HOME=str(checkout.parent / "power-cargo"),
                     CARGO_TARGET_DIR=str(checkout / "apps/power/target"), CARGO_BUILD_JOBS="2")
    run_builder([str(toolchain / "cargo"), "build", "--locked", "--release",
                 "--manifest-path", str(checkout / "apps/power/Cargo.toml")],
                cwd=checkout, env=build_env)
    helper = (checkout / "apps/power/target/release/PilotPower").resolve(strict=True)
    if not helper.is_relative_to(checkout.resolve(strict=True)) or not helper.is_file() or not os.access(helper, os.X_OK):
        raise ValueError("Power helper must be a source-contained executable")
    destination = runtime / "bin/PilotPower"
    destination.parent.mkdir(exist_ok=True)
    shutil.copyfile(helper, destination)
    destination.chmod(0o755)
    package.write_json(runtime / "power-inputs.json", dict(source=expected, target=package.TARGET,
        sha256=package.digest(destination), bytes=destination.stat().st_size, qualification="unqualified"))


def run_builder(command, cwd, env, timeout=1800):
    """Keep the owned leader unreaped until its build process group is drained."""
    child = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)
    timed_out = False
    try:
        # WNOWAIT observes the exit without reaping. Polling instead of pidfd_open
        # because the manylinux builder's Python is compiled without it.
        deadline = time.monotonic() + timeout
        while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
            if time.monotonic() >= deadline:
                timed_out = True
                break
            time.sleep(0.2)
    finally:
        # Even a failed/finished shell can leave a compiler or package helper.
        # Its unreaped leader reserves this group identity until wait below.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        finally:
            code = child.wait()
    if timed_out:
        raise subprocess.TimeoutExpired(command, timeout)
    if code:
        raise subprocess.CalledProcessError(code, command)


def extract(archive, destination):
    """Bound headers/expanded bytes before extraction; data filter fences links."""
    with tarfile.open(archive) as tar:
        members, names = [], {}
        def name(value):
            path = PurePosixPath(value)
            if path.is_absolute() or ".." in path.parts or not path.parts:
                raise ValueError("Unsafe archive path")
            return str(path)
        for member in tar:
            if len(members) >= CAP_FILES or member.size < 0:
                raise ValueError("Source/runtime archive exceeds package policy")
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError("Unsupported source/runtime archive object")
            key = name(member.name)
            if key in names:
                raise ValueError("Duplicate archive path")
            names[key] = member
            members.append(member)
        expanded, total = [], 0
        for member in members:
            target = member
            seen = set()
            while target.islnk():
                if target.name in seen:
                    raise ValueError("Cyclic hardlink chain")
                seen.add(target.name)
                target = names.get(name(target.linkname))
                if target is None:
                    raise ValueError("Missing hardlink target")
            if member.islnk():
                if not target.isfile():
                    raise ValueError("Hardlink target must be a regular archive file")
                # Materialize a distinct file from the target's archive bytes.
                # Never create filesystem hardlinks or follow their path at runtime.
                member = member.replace()
                member.type, member.linkname = tarfile.REGTYPE, ""
                member.size, member.offset_data = target.size, target.offset_data
            total += member.size
            if member.size > 256 * 1024**2 or total > CAP_BYTES:
                raise ValueError("Source/runtime archive exceeds package policy")
            expanded.append(member)
        tar.extractall(destination, members=expanded, filter="data")


def produce(expected, output, repository=ROOT):
    package.native_host()
    package.source(expected)
    if output.exists() or output.is_symlink():
        raise ValueError("Runtime output must be fresh")
    if subprocess.check_output(["git", "cat-file", "-t", expected], cwd=repository, text=True).strip() != "commit":
        raise ValueError("Immutable runtime source must be a commit")
    output.mkdir(mode=0o700)
    try:
        with tempfile.TemporaryDirectory(prefix="linux-gui-runtime-source-", dir=output.parent) as temporary:
            temporary = Path(temporary)
            checkout = temporary / "source"
            checkout.mkdir()
            archive = temporary / "source.tar"
            with archive.open("wb") as stream:
                subprocess.run(["git", "archive", "--format=tar", expected], cwd=repository,
                               stdout=stream, check=True, timeout=60)
            extract(archive, checkout)
            # Reuse the existing production closure builder without editing its
            # retirement-owned release contracts. Its archive/unsigned metadata
            # are temporary intermediates only, never published or shipped.
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                   "PILOT_RELEASE_COMMIT": expected, "MAKEFLAGS": "-j2", "CMAKE_BUILD_PARALLEL_LEVEL": "2"}
            for name, directory in (("HOME", "home"), ("XDG_CONFIG_HOME", "config"),
                                    ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("TMPDIR", "tmp")):
                path = temporary / directory
                path.mkdir(mode=0o700)
                env[name] = str(path)
            products = temporary / "products"
            run_builder(["/bin/bash", str(checkout / "scripts/linux/bundle-runtime.sh"), str(products)],
                        cwd=checkout, env=env)
            extract(products / "Pilot-linux-x64.tar.gz", output)
            runtime = output / "runtime"
            stage_power(checkout, runtime, expected, env)
            node = subprocess.check_output([str(runtime / "node/bin/node"), "--version"],
                                           env=env, text=True, timeout=10).strip().removeprefix("v")
            package.write_json(runtime / "runtime-build.json", dict(schema=1, source=expected,
                               version=package.read_json(checkout / "package.json")["version"],
                               protocol=1, platform="linux", arch="x64", node=node))
            package.runtime_identity(runtime, expected)
            files = package.inventory(runtime)
            package.write_json(output / "runtime-receipt.json", dict(schema=1, source=expected,
                               target=package.TARGET, files=files,
                               source_tree=subprocess.check_output(["git", "rev-parse", expected + "^{tree}"],
                                                                   cwd=repository, text=True).strip(),
                               producer="immutable-source-existing-linux-closure",
                               producer_sha256=package.digest(Path(__file__)),
                               closure_builder_sha256=package.digest(checkout / "scripts/linux/bundle-runtime.sh"),
                               bundled_launch=False, installer=False, updater=False))
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repository", type=Path, default=ROOT)
    args = parser.parse_args()
    produce(args.source, args.output.absolute(), args.repository.resolve())
