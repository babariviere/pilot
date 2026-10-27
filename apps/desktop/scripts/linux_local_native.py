#!/usr/bin/env python3
"""Owned Linux bundled Local fixture. Never discovers or signals user daemons.

Requires an explicitly supplied package and same-user Wayland socket. Linux
subreaper adoption proves ownership of detached descendants before pidfd cleanup.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time


def until(check, seconds=55):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise TimeoutError("Owned Linux Local fixture did not reach its expected state")


def qualify(package, wayland, output):
    if os.uname().sysname != "Linux" or os.uname().machine != "x86_64":
        raise ValueError("Native Linux x86_64 required")
    package = package.resolve(strict=True)
    if not wayland.is_absolute() or wayland.stat().st_uid != os.getuid():
        raise ValueError("An explicit same-user Wayland socket is required")
    # Detached bundled children become our children after their launcher exits.
    # This is only our fixture process, never a global service or process census.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError("Cannot establish owned descendant cleanup")
    def interrupted(signum, frame):
        raise InterruptedError("Owned Linux fixture interrupted")
    for name in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(name, interrupted)
    output.mkdir(mode=0o700)
    gui = None
    adopted = {}
    events = []
    private = output / "private-profile"
    private.mkdir(mode=0o700)
    root = private.resolve()
    for name in ("home", "data", "config", "cache"):
        (root / name).mkdir(mode=0o700)
    profile = root / "data/pilot"
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    env = {"HOME": str(root / "home"), "XDG_DATA_HOME": str(root / "data"),
           "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
           "XDG_RUNTIME_DIR": str(wayland.parent), "WAYLAND_DISPLAY": wayland.name,
           "LIBGL_ALWAYS_SOFTWARE": "1", "WGPU_BACKEND": "vulkan", "WAYLAND_DEBUG": "1",
           "PATH": "/usr/bin:/bin", "PILOT_HOME": str(profile), "PILOT_PORT": str(port),
           "PILOT_MODEL_SCOPE_READ_ONLY": "1", "PILOT_MCP_SETUP_READ_ONLY": "1",
           "PILOT_ENVIRONMENT_SETUP": "0", "PILOT_WORKSPACE_RETENTION_DAYS": "0"}
    children_file = Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children")

    def adopt():
        for pid in map(int, children_file.read_text().split()):
            if gui is not None and pid == gui.pid:
                continue
            if pid not in adopted:
                # pidfd reserves this exact direct descendant, not an owner-record PID.
                descriptor = os.pidfd_open(pid)
                status = Path(f"/proc/{pid}/status").read_text()
                if f"PPid:\t{os.getpid()}\n" not in status:
                    os.close(descriptor)
                    raise RuntimeError("Lost owned descendant admission")
                adopted[pid] = descriptor

    def launch(label):
        nonlocal gui
        log = output / (label + ".wayland.log")
        with log.open("wb") as stream:
            gui = subprocess.Popen([str(package / "bin/pilot-next")], env=env,
                                   stdout=subprocess.DEVNULL, stderr=stream)
        return log

    def daemon_children(runtime):
        entry = str(runtime / "packages/daemon/src/main.ts").encode()
        daemons = []
        for pid in adopted:
            try:
                args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
                if len(args) > 1 and args[1] == entry:
                    daemons.append(pid)
            except FileNotFoundError:
                pass
        return daemons

    def ready():
        adopt()
        if gui.poll() is not None:
            raise RuntimeError("Bundled GUI exited before Local readiness")
        try:
            record = json.loads((profile / ".daemon-owner.json").read_text())
            runtime = Path(record["runtimeRoot"])
            result = subprocess.run([str(runtime / "node/bin/node"), "--input-type=module", "-e",
                "import {inspectRuntime} from " + json.dumps((runtime / "packages/daemon/src/runtime-owner.ts").as_uri()) + ";"
                + "console.log(await inspectRuntime(" + json.dumps(str(profile)) + "," + str(port) + ","
                + json.dumps(record["build"]) + "," + json.dumps(str(runtime)) + "));"], env=env, capture_output=True, timeout=3)
            return record if result.returncode == 0 and result.stdout.strip() == b"ready" else None
        except (FileNotFoundError, KeyError, json.JSONDecodeError):
            return None

    def close_gui():
        nonlocal gui
        gui.terminate()
        gui.wait(timeout=10)
        gui = None
        adopt()

    try:
        first_log = launch("fresh")
        first = until(ready)
        capsule = Path(first["runtimeRoot"]).parent
        expected_id = hashlib.sha256((package / "linux-gui-package.json").read_bytes()).hexdigest()
        assert capsule == root / "data/pilot-next/runtimes" / expected_id / "payload"
        def daemon_adopted():
            adopt()
            return first["pid"] in adopted
        # Ready can precede launcher exit by a frame. Wait for actual adoption,
        # rather than treating the still-owned launcher relationship as failure.
        until(daemon_adopted, seconds=5)
        assert daemon_children(capsule / "runtime") == [first["pid"]], "Exactly one owned activated daemon expected"
        daemon_pid = first["pid"]
        assert first["pid"] == daemon_pid
        until(lambda: b"wl_surface" in first_log.read_bytes() and b".attach(" in first_log.read_bytes())
        events.append("fresh-GUI-owned-profile-ready-Wayland-buffer")
        marker = profile / "fixture-history-marker"
        marker.write_text("owned fixture history remains")
        close_gui()
        assert Path(f"/proc/{daemon_pid}").exists(), "GUI exit must preserve activated daemon"
        events.append("GUI-exit-preserves-activated-daemon")
        # Remove the original GUI/runtime path from use, without touching the
        # retained capsule. Replace it only inside our explicit fixture tree.
        moved = package.with_name(package.name + " moved")
        package.rename(moved)
        package = moved
        launch("reuse-relocated")
        second = until(ready)
        assert (second["boot"], second["pid"], second["runtimeRoot"]) == (first["boot"], first["pid"], first["runtimeRoot"])
        assert daemon_children(capsule / "runtime") == [daemon_pid]
        assert marker.read_text() == "owned fixture history remains"
        events.append("exact-compatible-reuse-after-GUI-relocation-no-second-daemon")
        close_gui()
        receipt = {"schema": 1, "source": first["build"]["source"], "build": first["build"],
                   "capsule": expected_id, "events": events, "daemonUnchanged": True,
                   "guiSha256": hashlib.sha256((package / "libexec/pilot-desktop").read_bytes()).hexdigest(),
                   "qualifierSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   "nativeVisualConfinement": "not-qualified-separate-dependency"}
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt))
    finally:
        if gui is not None and gui.poll() is None:
            gui.terminate()
            gui.wait(timeout=10)
        gui = None
        while True:
            adopt()
            if not adopted:
                break
            for pid, descriptor in list(adopted.items()):
                # Reaping an owned launcher can adopt its daemon. Drain again
                # after each batch, never leave that later descendant behind.
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
                os.close(descriptor)
                del adopted[pid]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True, help="owned disposable package copy; renamed during qualification")
    parser.add_argument("--wayland", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    qualify(args.package, args.wayland, args.output)
