#!/usr/bin/env python3
"""Owned Cage + real GUI Wayland transport probe, not visual-source qualification.

Cage may serve other X11 clients. This client has no DISPLAY and Pilot's
production backend remains Wayland-only. Never use the user's KDE socket/profile.
"""
import argparse
import os
from pathlib import Path
import re
import resource
import subprocess
import tempfile
import time


def limits():
    # Includes Wayland shm memfds. Do not reuse the helper's file-size limit0.
    resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024**2,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))


def stop(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
    assert not Path(f"/proc/{child.pid}").exists(), "owned child not reaped"


def probe(binary, parent, checks=False):
    assert os.uname().sysname == "Linux"
    with tempfile.TemporaryDirectory(prefix="cage-native-client-", dir=parent) as directory:
        root = Path(directory)
        for name in ("home", "config", "data", "cache", "run"):
            (root / name).mkdir(mode=0o700)
        env = dict(PATH="/usr/bin:/bin", HOME=str(root / "home"),
                   XDG_CONFIG_HOME=str(root / "config"), XDG_DATA_HOME=str(root / "data"),
                   XDG_CACHE_HOME=str(root / "cache"), XDG_RUNTIME_DIR=str(root / "run"),
                   LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe")
        # No ambient DISPLAY, WAYLAND_DISPLAY, inherited Wayland socket or DBus.
        assert "DISPLAY" not in env
        refusal = subprocess.run([str(binary), "--fixture", "fence"],
                                 env=dict(env, DISPLAY=":99"), capture_output=True, timeout=10)
        assert refusal.returncode != 0 and b"Native Wayland required" in refusal.stderr
        print("PASS missing Wayland refused despite DISPLAY", flush=True)
        with (root / "cage.log").open("wb") as log:
            cage = subprocess.Popen(["/usr/bin/cage", "-D"], stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=log, preexec_fn=limits,
                                    env=dict(env, WLR_BACKENDS="headless", WLR_RENDERER="pixman",
                                             WLR_LIBINPUT_NO_DEVICES="1"))
            try:
                end = time.monotonic() + 10
                while not (sockets := [p.name for p in (root / "run").glob("wayland-*") if p.is_socket()]):
                    if cage.poll() is not None or time.monotonic() >= end:
                        raise AssertionError("Owned Cage failed: " + (root / "cage.log").read_text()[-4000:])
                    time.sleep(0.05)
                assert len(sockets) == 1
                client_env = dict(env, WAYLAND_DISPLAY=sockets[0], WAYLAND_DEBUG="1")
                seat = subprocess.run(["/usr/bin/wayland-info"], env=client_env,
                                      capture_output=True, timeout=10, check=True)
                assert b"interface: 'wl_seat'" in seat.stdout and b"name: seat0" in seat.stdout
                print("PASS real wl_seat/seat0 on owned headless/pixman Cage", flush=True)
                path = root / "gui.log"
                with path.open("wb") as trace:
                    app = subprocess.Popen([str(binary), "--fixture", "fence"],
                                           env=client_env, stdin=subprocess.DEVNULL,
                                           stdout=trace, stderr=trace, preexec_fn=limits)
                    try:
                        try:
                            app.wait(timeout=8)
                        except subprocess.TimeoutExpired:
                            pass
                        text = path.read_text(errors="replace")
                        assert app.poll() is None, "GUI exited: " + text[-6000:]
                        environ = Path(f"/proc/{app.pid}/environ").read_bytes().split(b"\0")
                        assert not any(value.startswith(b"DISPLAY=") for value in environ)
                        assert "get_toplevel(" in text
                        assert re.search(r"wl_surface[^\n]*\.attach\(", text)
                        print("PASS exact GUI client DISPLAY unset, actual Wayland toplevel + buffer", flush=True)
                    finally:
                        stop(app)
                print("PASS owned GUI stopped/reaped", flush=True)
                if checks:
                    # Existing scoped native/library suites, same owned compositor.
                    # The Cargo home is the private prerequisite install, not ~/.cargo.
                    cargo_home = Path(os.environ["CARGO_HOME"]).resolve()
                    assert cargo_home.is_relative_to(parent)
                    checked_env = dict(client_env, CARGO_HOME=str(cargo_home),
                                       PATH=f"{cargo_home}/bin:/usr/bin:/bin")
                    desktop = Path(__file__).resolve().parent.parent
                    subprocess.run(["/usr/bin/python3", "scripts/check-scoped.py", "--unit", "visual_",
                                    "--worker", "--timeout", "900"],
                                   cwd=desktop, env=checked_env, timeout=1000, check=True)
                    # The general native wrapper remains macOS-only. This explicitly
                    # authorized Linux fixture runs just the existing expected-tree
                    # target, with the same pinned Cargo/profile and owned compositor.
                    subprocess.run(["bash", "scripts/cargo.sh", "test", "--locked", "-p", "pilot-desktop",
                                    "--features", "native-probes", "--test", "visuals"],
                                   cwd=desktop, env=checked_env, timeout=1000, check=True)
            finally:
                stop(cage)
            print("PASS owned Cage stopped/reaped", flush=True)
        print("Native Wayland backend fixture only. Helper/product visual execution NOT qualified.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True, help="Owned temporary parent only")
    parser.add_argument("--checks", action="store_true", help="Run existing scoped visual suites under owned Cage")
    args = parser.parse_args()
    probe(args.binary.resolve(), args.root.resolve(), args.checks)
