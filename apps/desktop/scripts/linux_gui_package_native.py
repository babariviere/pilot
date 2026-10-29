#!/usr/bin/env python3
"""Linux-native relocated GUI fixture probe, NOT full runtime qualification."""
import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import resource
import re
import shutil
import subprocess
import tempfile
import time

import linux_gui_package as package


def bounded_log():
    # Also bounds memfd wl_shm pools, which a software-rendered window grows past 8 MiB.
    resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024**2, 256 * 1024**2))


def stop(child):
    if child.poll() is None:
        child.terminate()  # Only this probe's exact synthetic child, never a daemon.
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


def observe_frame(app, path):
    # Separate the 12-second liveness check from the cold software-render deadline.
    # Allow up to 60 for actual rendering, never just a surviving PID.
    started = time.monotonic()
    while True:
        trace = path.read_text(errors="replace")
        if app.poll() is not None:
            raise ValueError("Fixture exited before observation: " + trace[-4000:])
        elapsed = time.monotonic() - started
        rendered = "get_toplevel(" in trace and re.search(r"wl_surface[^\n]*\.attach\(", trace)
        if elapsed >= 12 and rendered:
            return
        if elapsed >= 60:
            raise ValueError("No actual Wayland toplevel and attached rendered buffer after 60 seconds: "
                             + trace[-4000:])
        try:
            app.wait(timeout=min(0.25, 60 - elapsed))
        except subprocess.TimeoutExpired:
            pass


@contextmanager
def compositor_display(root, env, existing):
    if existing is not None:
        # Explicit opt-in only. Never signal or reconfigure an existing compositor.
        info = existing.lstat()
        import stat
        if not existing.is_absolute() or not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("Existing compositor must be an absolute same-user socket")
        yield str(existing)
        return
    # Headless Weston advertises no wl_seat, which GPUI requires. wlroots/sway
    # always advertises seat0, even with no input devices.
    config = root / "sway.config"
    config.write_text("xwayland disable\n")
    run = root / "run"
    with (root / "sway.log").open("wb") as log:
        compositor = subprocess.Popen(["sway", "--config", str(config)],
                                      env=dict(env, WLR_BACKENDS="headless", WLR_RENDERER="pixman",
                                               WLR_LIBINPUT_NO_DEVICES="1"),
                                      stdout=log, stderr=log, preexec_fn=bounded_log)
        try:
            deadline = time.monotonic() + 10
            while not (sockets := [path.name for path in run.glob("wayland-*") if path.is_socket()]):
                if compositor.poll() is not None or time.monotonic() >= deadline:
                    raise ValueError("Owned headless sway failed: " + (root / "sway.log").read_text()[-4000:])
                time.sleep(0.05)
            if len(sockets) != 1:
                raise ValueError("Owned headless sway socket is ambiguous")
            yield sockets[0]
        finally:
            stop(compositor)


def probe(binaries, output, expected, existing=None):
    package.native_host()
    package.source(expected)
    if output.exists():
        raise ValueError("Probe receipt must be fresh")
    # Caller pins the tested checkout: CI's merge SHA or the immutable release tag.
    # A retried release's GITHUB_SHA identifies its workflow, not its tagged app.
    tested = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if expected != tested:
        raise ValueError("Native probe source mismatch")
    with tempfile.TemporaryDirectory(prefix="linux-gui-fixture-") as directory:
        root = Path(directory)
        stage = root / "staged"
        stage.mkdir()
        entries = []
        for name in package.BINARIES:
            shutil.copyfile(binaries / name, stage / name)
            (stage / name).chmod(0o755)
            entries.append(dict(name=name, sha256=package.digest(stage / name), bytes=(stage / name).stat().st_size))
        relocated = root / "relocated GUI with spaces"
        stage.rename(relocated)
        dependencies = package.elf_closure(relocated)
        if {item["path"] for item in dependencies} != set(package.BINARIES):
            raise ValueError("Both GUI/helper must be native ELF executables")
        for name in ("home", "config", "data", "cache", "run"):
            (root / name).mkdir(mode=0o700)
        env = dict(PATH="/usr/bin:/bin", HOME=str(root / "home"),
                   XDG_CONFIG_HOME=str(root / "config"), XDG_DATA_HOME=str(root / "data"),
                   XDG_CACHE_HOME=str(root / "cache"), XDG_RUNTIME_DIR=str(root / "run"),
                   LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe")
        executable = str(relocated / "pilot-desktop")
        result = subprocess.run([executable, "--help"], env=env, capture_output=True, timeout=10)
        if result.returncode != 0 or b"Pilot Next" not in result.stdout:
            raise ValueError("Relocated help failed")
        # An X11-looking environment must not bypass the actual Wayland socket fence.
        result = subprocess.run([executable, "--fixture", "fence"], env=dict(env, DISPLAY=":99"),
                                capture_output=True, timeout=10)
        if result.returncode == 0 or b"Native Wayland required" not in result.stderr:
            raise ValueError("Missing compositor did not fail closed")
        with compositor_display(root, env, existing) as display:
            path = root / "wayland.log"
            with path.open("wb") as trace:
                app = subprocess.Popen([executable, "--fixture", "fence"],
                                       env=dict(env, WAYLAND_DISPLAY=display, WAYLAND_DEBUG="1"),
                                       stdout=trace, stderr=trace, preexec_fn=bounded_log)
                try:
                    observe_frame(app, path)
                finally:
                    stop(app)
        package.write_json(output, dict(schema=1, kind="linux-native-gui-fixture-only", source=tested,
                           source_tree=subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip(),
                           target=package.TARGET, binaries=entries, dependencies=dependencies,
                           relocation=True, no_wayland_refused=True, wayland_toplevel_and_buffer=True,
                           full_runtime_qualified=False, bundled_launch=False, native_confinement=False,
                           installer=False, updater=False,
                           compositor="existing-wayland-explicit" if existing else "owned-headless-sway",
                           limits="Software-rendered fixture only. No GPU, IME, frame pacing or daemon execution acceptance."))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binaries", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--existing-wayland-socket", type=Path,
                        help="Explicitly show a short synthetic window on this compositor; never stop it")
    args = parser.parse_args()
    probe(args.binaries.resolve(), args.output.absolute(), args.source, args.existing_wayland_socket)
