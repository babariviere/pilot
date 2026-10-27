#!/usr/bin/env python3
"""Real GPUI/full-payload update fixture. Synthetic keys and owned temporary data only."""
import argparse
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile

import gui_release
import linux_gui_package as package
from linux_local_native import until

PUBLIC = "GX9rI+FshTLGq8g4+s1ep4m+DHaykgM0A5v6iz02jWE="
DRAFT = "Owned update draft 👩‍💻 e\u0301 日本語"
NODE_SIGN = """import{readFileSync}from'node:fs';import{createPrivateKey,sign}from'node:crypto';
const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,42)]),format:'der',type:'pkcs8'});
process.stdout.write(sign(null,readFileSync(0),key).toString('base64'));"""


def signature(node, raw):
    return subprocess.check_output([str(node), "--input-type=module", "-e", NODE_SIGN], input=raw, timeout=10)


def qualify(old, new, wayland, case="success", install_name="Pilot Next"):
    package.native_host()
    old, new = old.resolve(strict=True), new.resolve(strict=True)
    if not wayland.is_absolute() or wayland.stat().st_uid != os.getuid():
        raise ValueError("Explicit same-user Wayland socket required")
    metadata = []
    for path in (old, new):
        package.verify(path)
        value = package.read_json(path / package.MANIFEST)
        config = package.read_json(path / "rust-inputs.json")["updater_configuration"]
        if (value["application_id"] != "com.example.synthetic.next" or config["public_key"] != PUBLIC
                or config["repository"] != "synthetic/fixture-only"):
            raise ValueError("Only explicitly compiled synthetic fixture inputs are accepted")
        node = path / "runtime/node/bin/node"
        (path / "linux-gui-package.sig").write_bytes(signature(node, (path / package.MANIFEST).read_bytes()))
        metadata.append(value)
    before, after = metadata
    if before["bundle_build"] != "100.1" or after["bundle_build"] != "101.1":
        raise ValueError("Individually source-matched old100.1/new101.1 fixture builds required")
    capsule_id = package.digest(old / package.MANIFEST)
    if capsule_id not in package.read_json(new / "update-runtime-policy.json")["accepted_capsules"]:
        raise ValueError("Candidate must explicitly admit the exact old capsule")
    root = Path(tempfile.mkdtemp(prefix="next-owned-gui-update-", dir="/tmp"))
    print(f"Owned full-GUI update fixture: {root}", flush=True)
    install = root / "install with spaces"
    install.mkdir(mode=0o700)
    target = install / install_name
    shutil.copytree(old, target, symlinks=True)
    node = target / "runtime/node/bin/node"
    archive_dir = root / "archive-input"
    gui_release.linux_archive(after["source"], new, archive_dir, "101.1")
    archive = root / "archive.zip"
    (archive_dir / gui_release.LINUX_ARCHIVE).rename(archive)
    signed = dict(schema=1, source=after["source"], application_id=after["application_id"], channel="desktop-stable",
                  platform="linux", architecture="x86_64", build="101.1", short_version=after["short_version"],
                  bundle_name="Pilot Next", archive_name=gui_release.LINUX_ARCHIVE, archive_asset_id=12,
                  archive_size=archive.stat().st_size, archive_sha256=package.digest(archive))
    if case == "wrong-platform":
        signed["platform"] = "macos"
    elif case == "wrong-source":
        signed["source"] = "b" * 40
    elif case == "wrong-hash":
        signed["archive_sha256"] = "0" * 64
    raw = json.dumps(signed, separators=(",", ":")).encode()
    sig = signature(node, raw)
    if case == "wrong-signature":
        damaged = bytearray(base64.b64decode(sig))
        damaged[0] ^= 1
        sig = base64.b64encode(damaged)
    (root / "envelope.json").write_text(json.dumps(dict(signed=base64.b64encode(raw).decode(), signature=sig.decode())))
    for name in ("home", "data", "config", "cache", "state"):
        (root / name).mkdir(mode=0o700)
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    profile = root / "data/pilot"
    env = dict(HOME=str(root / "home"), XDG_DATA_HOME=str(root / "data"), XDG_CONFIG_HOME=str(root / "config"),
               XDG_CACHE_HOME=str(root / "cache"), XDG_STATE_HOME=str(root / "state"), XDG_RUNTIME_DIR=str(wayland.parent),
               WAYLAND_DISPLAY=wayland.name, LIBGL_ALWAYS_SOFTWARE="1", WGPU_BACKEND="vulkan", WAYLAND_DEBUG="1",
               PATH="/usr/bin:/bin", PILOT_HOME=str(profile), PILOT_PORT=str(port), PILOT_MODEL_SCOPE_READ_ONLY="1",
               PILOT_MCP_SETUP_READ_ONLY="1", PILOT_ENVIRONMENT_SETUP="0", PILOT_WORKSPACE_RETENTION_DAYS="0",
               PILOT_NEXT_UPDATER_FIXTURE=str(root))
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError("Owned fixture subreaper unavailable")
    def interrupted(signum, frame):
        raise InterruptedError("Owned Linux update fixture interrupted")
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    adopted = {}
    gui = None
    receipt = dict(schema=1, kind="native-GPUI-full-payload-update-fixture", production=False,
                   source=after["source"], oldSource=before["source"], fixtureRoot=str(root), case=case, events=[], passed=False)

    def adopt():
        children = Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children")
        for pid in map(int, children.read_text().split()):
            if gui is not None and pid == gui.pid:
                continue
            if pid not in adopted:
                descriptor = os.pidfd_open(pid)
                if f"PPid:\t{os.getpid()}\n" not in Path(f"/proc/{pid}/status").read_text():
                    os.close(descriptor)
                    raise RuntimeError("Lost owned descendant admission")
                adopted[pid] = descriptor

    def reap():
        for pid, descriptor in list(adopted.items()):
            try:
                done = os.waitpid(pid, os.WNOHANG)[0]
            except ChildProcessError:
                done = pid
            if done:
                os.close(descriptor)
                del adopted[pid]

    def owner_ready():
        adopt()
        try:
            value = package.read_json(profile / ".daemon-owner.json")
            runtime = Path(value["runtimeRoot"])
            code = ("import{inspectRuntime}from " + json.dumps((runtime / "packages/daemon/src/runtime-owner.ts").as_uri())
                    + ";console.log(await inspectRuntime(" + json.dumps(str(profile)) + "," + str(port) + ","
                    + json.dumps(value["build"]) + "," + json.dumps(str(runtime)) + "));")
            result = subprocess.run([str(runtime / "node/bin/node"), "--input-type=module", "-e", code],
                                    env=env, capture_output=True, timeout=3)
            return value if result.returncode == 0 and result.stdout.strip() == b"ready" else None
        except (FileNotFoundError, KeyError, json.JSONDecodeError):
            return None

    def acknowledged():
        adopt()
        if case == "success":
            diagnostic = (root / "old-wayland.log").read_bytes()
            if b"fixture-updater-state=Some(Deferred" in diagnostic or b"fixture-cancel-prepared=" in diagnostic:
                raise RuntimeError("Owned GUI deferred/cancelled preparation; inspect its fixture diagnostics")
        rows = list(install.glob(".pilot-next-update-*/journal.json"))
        return rows[0].parent if len(rows) == 1 and package.read_json(rows[0]).get("phase") == "StartupAcknowledged" else None

    try:
        with (root / "old-wayland.log").open("wb") as log:
            gui = subprocess.Popen([str(target / "bin/pilot-next")], env=env, stdout=subprocess.DEVNULL, stderr=log)
        first = until(owner_ready, seconds=55)
        original = (profile / ".daemon-owner.json").read_bytes()
        (profile / "fixture-history-marker").write_text("retained owned history")
        receipt["events"].append("actual-old-GPUI-private-Local-ready")
        if case != "success":
            until(lambda: b"fixture-updater-state=Some(Failed(" in (root / "old-wayland.log").read_bytes(), seconds=120)
            assert gui.poll() is None, "Refused update must not quit the GUI"
            assert (profile / ".daemon-owner.json").read_bytes() == original
            assert (profile / "fixture-history-marker").read_text() == "retained owned history"
            assert not acknowledged(), "Refused update must never acquire startup acceptance"
            for journal in install.glob(".pilot-next-update-*/journal.json"):
                assert package.read_json(journal)["phase"] not in ("Committed", "Swapped", "RelaunchRequested", "StartupAcknowledged")
            package.verify(target)
            assert package.digest(target / "libexec/pilot-desktop") == package.digest(old / "libexec/pilot-desktop")
            receipt.update(passed=True, daemonUnchanged=True, refused=case)
            receipt["events"].append("affirmative-native-updater-failure-without-install-or-quit")
            print(json.dumps(receipt))
            return
        transaction = until(acknowledged, seconds=240)
        assert gui.wait(timeout=5) == 0, "Old GUI must exit only after its real checkpoint and COMMIT"
        gui = None
        def upgraded():
            reap()
            value = owner_ready()
            return value if value and value["runtimeRoot"] != first["runtimeRoot"] else None

        # After acknowledging startup, the new app pauses the old daemon's tools, stops it and starts its own runtime.
        second = until(upgraded, seconds=180)
        assert second["pid"] != first["pid"] and first["pid"] not in adopted
        assert Path(second["runtimeRoot"]).parent.parent.name == package.digest(new / package.MANIFEST)
        assert (profile / "fixture-history-marker").read_text() == "retained owned history"
        state = package.read_json(root / "state/pilot-next/state-v1.json")
        assert state["drafts"]["new:update-fixture"]["text"] == DRAFT and not state["pending"]
        package.verify(target)
        package.verify(transaction / "install-payload/Pilot Next")
        package.verify(Path(first["runtimeRoot"]).parent)
        assert package.digest(target / "libexec/pilot-desktop") == package.digest(new / "libexec/pilot-desktop")
        assert package.digest(transaction / "install-payload/Pilot Next/libexec/pilot-desktop") == package.digest(old / "libexec/pilot-desktop")
        for log in (root / "old-wayland.log", root / "relaunch-wayland.log"):
            until(lambda: log.exists() and b"wl_surface" in log.read_bytes() and b".attach(" in log.read_bytes(), seconds=10)
        adopt()
        reap()
        daemons = [pid for pid in adopted if Path(f"/proc/{pid}/cmdline").exists()
                   and any(str(Path(run["runtimeRoot"]) / "packages/daemon/src/main.ts").encode()
                           in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") for run in (first, second))]
        assert daemons == [second["pid"]], "Exactly one daemon, on the new runtime, may use the fixture profile"
        receipt.update(passed=True, daemonUpgraded=True, transaction=str(transaction), capsule=capsule_id,
                       oldGuiSha256=package.digest(old / "libexec/pilot-desktop"), newGuiSha256=package.digest(new / "libexec/pilot-desktop"))
        receipt["events"] += ["real-draft-checkpoint-and-explicit-COMMIT", "OS-parent-exit-and-verified-whole-payload-exchange",
                               "actual-new-GPUI-Wayland-buffer-and-durable-startup-ACK", "retained-draft-history-and-daemon-upgraded-to-new-runtime"]
        print(json.dumps(receipt))
    finally:
        (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        if gui is not None and gui.poll() is None:
            gui.terminate()
            gui.wait(timeout=10)
        gui = None
        while True:
            adopt()
            if not adopted:
                break
            for pid, descriptor in list(adopted.items()):
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
                os.close(descriptor)
                del adopted[pid]
        print(f"Owned full-GUI update receipt retained: {root}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old", type=Path, required=True)
    parser.add_argument("--new", type=Path, required=True)
    parser.add_argument("--wayland", type=Path, required=True)
    parser.add_argument("--case", choices=("success", "wrong-signature", "wrong-platform", "wrong-hash", "wrong-source"), default="success")
    parser.add_argument("--install-name", default="Pilot Next", help="installed directory name (users may rename it)")
    args = parser.parse_args()
    qualify(args.old, args.new, args.wayland, args.case, args.install_name)
