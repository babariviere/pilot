#!/usr/bin/env python3
"""Local demo preview using the installed NSH packager, never production bootstrap.

Build only committed source, check it, then stage an immutable .app. A failed
build leaves the installed app and NSH's separate preview storage untouched.
No watcher, service, daemon, provider, signing keys or forced quit is involved.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

APP = "Pilot Preview.app"
IDENTITY = "dev.pilot.preview"
DEFAULT_HOME = Path.home() / "Library/Application Support/Pilot Preview"


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def atomic_text(path, text):
    temporary = path.with_name(path.name + ".new")
    with temporary.open("w") as out:
        out.write(text)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)


@contextlib.contextmanager
def locked(home, name="install.lock"):
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Keep the inode: never unlink a shared lock.
    with (home / name).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def executable(app):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != IDENTITY:
        raise ValueError("Refusing a non-preview bundle")
    name = info["CFBundleExecutable"]
    if not name or Path(name).name != name:
        raise ValueError("Invalid preview executable")
    return app / "Contents/MacOS" / name


def running(home):
    # Fail closed if process inventory is unavailable. Old versions stay in
    # place even if Finder races this check, so no running bytes are replaced.
    commands = run(["/bin/ps", "-axo", "comm="], capture_output=True, text=True).stdout.splitlines()
    versions = (home / "versions").resolve()
    return any(Path(line.strip()).resolve().is_relative_to(versions) for line in commands if line.strip())


def validate(app):
    binary = executable(app)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError("Preview executable is missing")
    resources = app / "Contents/Resources/nsh"
    if not (resources / "bundle.nshc").is_file():
        raise ValueError("Preview bundle is missing")
    metadata = json.loads((resources / "app.json").read_text())
    if metadata.get("id") != IDENTITY or not metadata.get("name", "").startswith("Pilot Preview"):
        raise ValueError("Preview metadata does not match")
    # No grants: NSH serializes explicit denials, not necessarily {}.
    grants = json.loads((resources / "capabilities.json").read_text())
    denied = dict(network=dict(hosts=[], http=[]),
                  process=dict(execute=[], exit=False, env=[]), fs=dict(read=[], write=[]),
                  statusBar=False, clipboard=False, picker=False, openUrl=False)
    if grants != denied:
        raise ValueError("Preview must not grant any host capabilities")
    run(["/usr/bin/codesign", "--verify", "--strict", app])


def activate(home):
    pending = home / "pending.json"
    if not pending.exists():
        return False
    record = json.loads(pending.read_text())
    source = record["source"]
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("Invalid preview source")
    app = home / "versions" / source / APP
    validate(app)
    if running(home):
        print("Preview is running. Checked build staged for the next launch; nothing replaced.")
        return False
    destination = home / "current"
    if destination.exists() and not destination.is_symlink():
        raise ValueError("Refusing to overwrite an unmanaged current directory")
    link = home / "current.new"
    if link.is_symlink():
        link.unlink()
    link.symlink_to(app.parent)
    os.replace(link, destination)
    # pending remains as an idempotent pointer, not a command to replay.
    print(f"Preview ready: {app} (demo data, source {source})")
    return True


def install_launcher(home, applications):
    applications.mkdir(parents=True, exist_ok=True)
    launcher = applications / "Pilot Preview.command"
    # Only replace our own previous launcher; never Pilot.app or its identities.
    marker = "# Pilot demo preview launcher v1"
    if launcher.exists() and marker not in launcher.read_text():
        raise ValueError(f"Unmanaged launcher already exists: {launcher}")
    import shlex
    script = home / "preview.py"
    atomic_text(launcher, "#!/bin/bash\n" + marker + "\nexec /usr/bin/env python3 " +
                shlex.quote(str(script)) + " --home " + shlex.quote(str(home)) + " launch\n")
    launcher.chmod(0o755)
    return launcher


def build(args):
    repo = Path(__file__).resolve().parents[3]
    source = run(["/usr/bin/git", "-C", repo, "rev-parse", "--verify", args.source + "^{commit}"],
                 capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("Expected an immutable commit")
    manager = run(["/usr/bin/git", "-C", repo, "show", f"{source}:apps/day/scripts/preview.py"], capture_output=True).stdout
    if manager != Path(__file__).read_bytes():
        raise ValueError("Run the preview builder from the selected source version")
    # The dependency tree belongs to this workspace and the exact source lock.
    lock = run(["/usr/bin/git", "-C", repo, "show", f"{source}:pnpm-lock.yaml"], capture_output=True).stdout
    if lock != (repo / "pnpm-lock.yaml").read_bytes() or not (repo / "node_modules/.bin/tsgo").exists():
        raise ValueError("Prepare private exact-source Node dependencies first")
    home = args.home.resolve()
    # Compilation must not block the user from launching the old app.
    with locked(home, "build.lock"):
        versions = home / "versions"
        versions.mkdir(exist_ok=True)
        destination = versions / source
        if not destination.exists():
            # Short TMPDIR avoids mbx's macOS Unix-socket path limit.
            with tempfile.TemporaryDirectory(prefix="pv-build-", dir="/tmp") as temporary:
                stage = Path(temporary)
                archive = run(["/usr/bin/git", "-C", repo, "archive", source], capture_output=True).stdout
                import io
                with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                    tar.extractall(stage, filter="data")
                (stage / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
                day = stage / "apps/day"
                config = json.loads((day / "nsh.json").read_text())
                config.update(name=f"Pilot Preview {source[:8]}", id=IDENTITY)
                (day / "nsh.json").write_text(json.dumps(config))
                (day / "previewBuild.ts").write_text(f"export const previewSource = {json.dumps(source)};\n")
                env = dict(os.environ, TMPDIR=str(stage))
                wrapper = day / "nsh.sh"
                run([sys.executable, day / "scripts/test_preview.py"], env=env)
                run([wrapper, "check", "Preview.tsx"], env=env)
                run([wrapper, "build", "Preview.tsx"], env=env)
                for test in ("Preview.test.tsx", "Plan.test.tsx", "App.test.tsx"):
                    run([wrapper, "test", test], env=env)
                output = stage / "package"
                run([wrapper, "package", "Preview.tsx", "--target", "macos", "--name", "Pilot Preview",
                     "--out", output], env=env)
                app = output / APP
                validate(app)
                # Never update a version in place. Copy completes before promotion.
                staged = versions / (source + ".staging")
                if staged.exists():
                    raise ValueError(f"Interrupted staging exists; inspect it first: {staged}")
                shutil.copytree(output, staged)
                validate(staged / APP)
                (staged / "preview.py").write_bytes(manager)
                receipt = {"source": source, "data": "isolated-demo", "runtime": "nsh 0.4.0 (e626a8d)",
                           "executable_sha256": hashlib.sha256(executable(staged / APP).read_bytes()).hexdigest()}
                atomic_text(staged / "build.json", json.dumps(receipt, indent=2) + "\n")
                staged.rename(destination)
        validate(destination / APP)
        with locked(home):
            atomic_text(home / "pending.json", json.dumps({"source": source}) + "\n")
            # Launch never compiles and selects only an already checked app.
            atomic_text(home / "preview.py", (destination / "preview.py").read_text())
            launcher = install_launcher(home, args.applications)
            activate(home)
        print(f"Launch (opens a visible native window): {launcher}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=DEFAULT_HOME)
    commands = parser.add_subparsers(dest="command", required=True)
    builder = commands.add_parser("build", help="Check/package committed source and refresh only when closed")
    builder.add_argument("--source", required=True)
    builder.add_argument("--applications", type=Path, default=Path.home() / "Applications")
    commands.add_parser("refresh", help="Apply an already checked build only while closed")
    commands.add_parser("launch", help="Apply a checked pending build, then open the native demo")
    args = parser.parse_args()
    if args.command == "build":
        build(args)
    else:
        with locked(args.home):
            activate(args.home)
            app = args.home / "current" / APP
            validate(app)
            if args.command == "launch":
                run(["/usr/bin/open", app])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(f"Preview unchanged: {error}")
