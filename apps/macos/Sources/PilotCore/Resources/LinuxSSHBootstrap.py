"""Private SSH setup helper. Receives only an already authenticated archive, never credentials.

No sudo, package install, policy change, service restart/stop or daemon API mutation.
Paths are content-addressed; the service interface refuses foreign/different runtime units.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time


class Blocked(Exception):
    def __init__(self, code, detail, plan=None):
        self.result = dict(ok=False, code=code, detail=detail, plan=plan)


def private_directory(path):
    # Do not follow pre-existing symlinks in any installation ancestor.
    for parent in reversed([path, *path.parents]):
        if parent.exists() or parent.is_symlink():
            if parent.is_symlink() or not parent.is_dir():
                raise Blocked("paths", "An installation ancestor is a symlink or is not a directory.")
        else:
            parent.mkdir(mode=0o700)
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Blocked("paths", "The runtime directory must be private and owned by the service user.")


def extract(archive, destination):
    # Validate the complete namespace before creating any links. Never use extractall.
    with tarfile.open(archive, "r:gz") as source:
        entries = {}
        size = 0
        for item in source:
            path = PurePosixPath(item.name)
            if (path.is_absolute() or ".." in path.parts or not path.parts or
                    path.parts[0] != "runtime" or str(path) in entries or
                    any(ord(c) < 32 or ord(c) == 127 for c in item.name) or
                    not (item.isdir() or item.isfile() or item.issym() or item.islnk()) or
                    item.mode & 0o6000):
                raise Blocked("archive", "Unsafe archive entry. No runtime was installed.")
            entries[str(path)] = item
            size += item.size
            if len(entries) > 200000 or size > 2147483648:
                raise Blocked("archive", "Expanded runtime exceeds the setup limit.")
        for name, item in entries.items():
            for parent in PurePosixPath(name).parents:
                if str(parent) in entries and not entries[str(parent)].isdir():
                    raise Blocked("archive", "Archive entry traverses a link or file.")
            if item.issym() or item.islnk():
                target = item.linkname
                if not target or target.startswith("/"):
                    raise Blocked("archive", "Absolute or empty archive link.")
                resolved = os.path.normpath(str(PurePosixPath(name).parent / target) if item.issym() else target)
                if not resolved.startswith("runtime/") or resolved not in entries:
                    raise Blocked("archive", "Archive link escapes the runtime or is dangling.")
                if item.islnk() and not entries[resolved].isfile():
                    raise Blocked("archive", "Hard links must target a regular runtime file.")
        for name, item in entries.items():
            file = destination / name
            file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if item.isdir():
                file.mkdir(exist_ok=True, mode=0o700)
            elif item.isfile():
                with file.open("xb") as output, source.extractfile(item) as data:
                    shutil.copyfileobj(data, output, 1048576)
                file.chmod(0o700 if item.mode & 0o111 else 0o600)
        for name, item in entries.items():
            file = destination / name
            if item.issym():
                file.symlink_to(item.linkname)
            elif item.islnk():
                os.link(destination / os.path.normpath(item.linkname), file)
        # Resolving chains detects indirect escapes/cycles too, before any executable is run.
        root = (destination / "runtime").resolve(strict=True)
        for name, item in entries.items():
            if item.issym() and not (destination / name).resolve(strict=True).is_relative_to(root):
                raise Blocked("archive", "Archive link chain escapes the runtime.")
        for name in ["node/bin/node", "service.mjs", "packages/daemon/src/linux-coordinator-probe.ts"]:
            file = root / name
            if not file.is_file() or file.is_symlink():
                raise Blocked("archive", "The verified runtime is incomplete.")


def stage(base, digest, size, stream):
    final = base / digest
    # Always consume/check the upload, even on a repeat. Interrupted uploads are never published.
    with tempfile.TemporaryDirectory(prefix=".stage-", dir=base) as temporary:
        temporary = Path(temporary)
        (temporary / ".bootstrap-stage").write_text("pilot-bootstrap-v1")
        archive = temporary / "archive.tgz"
        remaining = size
        sha = hashlib.sha256()
        with archive.open("xb") as output:
            while remaining:
                chunk = stream.read(min(1048576, remaining))
                if not chunk:
                    raise Blocked("transfer", "Upload interrupted. Reconnect and repeat setup with the same package.")
                output.write(chunk)
                sha.update(chunk)
                remaining -= len(chunk)
        if stream.read(1) or sha.hexdigest() != digest:
            raise Blocked("archive", "Uploaded runtime size/checksum differs from the authenticated manifest.")
        if final.exists() or final.is_symlink():
            if final.is_symlink() or (final / "complete").is_symlink() or (final / "complete").read_text() != digest:
                raise Blocked("paths", "Existing runtime has no matching completion record. It was not overwritten.")
            private_directory(final)
            runtime = final / "runtime"
            if (runtime.is_symlink() or not runtime.is_dir() or runtime.stat().st_uid != os.getuid() or
                    runtime.stat().st_mode & 0o022):
                raise Blocked("paths", "Existing runtime path is not owned or is writable by another user.")
            return final / "runtime"
        unpack = temporary / "unpack"
        unpack.mkdir(mode=0o700)
        extract(archive, unpack)
        (unpack / "complete").write_text(digest)
        os.rename(unpack, final)
        return final / "runtime"


def command(args, code, detail, timeout=90):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=False, text=True)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked(code, detail)
    if result.returncode:
        raise Blocked(code, detail)
    return result.stdout


def read_identity(home):
    values = []
    for name in ["daemon-id", "storage-lineage"]:
        file = home / ".local/share/pilot" / name
        if not file.exists():
            return None
        value = file.read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", value):
            raise Blocked("identity", "Existing daemon identity is invalid. Repair it explicitly; setup never replaces identities.")
        values.append(value)
    return dict(daemonId=values[0], lineageId=values[1])


def installed_runtime(home, base):
    """Digest of an existing Pilot-managed unit's runtime, or None for no/foreign units.

    Read-only. The update flow re-verifies the full unit before it changes anything.
    """
    unit = home / ".config/systemd/user/pilotd.service"
    if unit.is_symlink() or not unit.is_file():
        return None
    text = unit.read_text()
    if not text.startswith("# Managed by Pilot Linux runtime v1\n"):
        return None
    match = re.search(r'^ExecStart="' + re.escape(str(base)) + r'/([a-f0-9]{64})/runtime/node/bin/node" ', text, re.M)
    return match.group(1) if match else None


def activate(root, home):
    helper = [str(root / "node/bin/node"), str(root / "service.mjs")]
    try:
        # Probe exits 2 for unmet prerequisites but still emits its structured privilege plan.
        probe = subprocess.run([*helper, "probe"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               timeout=30, text=True)
        report = json.loads(probe.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        raise Blocked("abi", "The private Node runtime could not execute. Check Linux x86-64, the manifest's libc/C++ floors, loader and executable filesystem policy. No global Node upgrade is needed.")
    if probe.returncode or not report.get("ok"):
        raise Blocked("prerequisites", "Service prerequisites are missing. Review the explicit package/user-manager/linger plan; setup does not run privileged commands.", report)
    command([*helper, "install"], "service", "Service install/enable failed. A foreign/different unit is never overwritten. Inspect journalctl --user -u pilotd and use the separate update flow for an installed runtime.")
    command([*helper, "start"], "service", "The owned service could not start. Inspect journalctl --user -u pilotd; setup never restarts an active service.")
    deadline = time.monotonic() + 30
    while True:
        state = json.loads(command([*helper, "status"], "service", "Cannot verify owned service status."))
        identity = read_identity(home)
        if state.get("ActiveState") == "active" and int(state.get("MainPID", "0")) > 0 and identity:
            break
        if time.monotonic() >= deadline:
            raise Blocked("service", "Service did not become active with a durable identity. Inspect journalctl --user -u pilotd.")
        time.sleep(0.2)
    enabled = command(["systemctl", "--user", "is-enabled", "pilotd.service"], "persistence", "pilotd.service is not enabled for boot. Repair the user service before retrying.")
    if enabled.strip() != "enabled":
        raise Blocked("persistence", "pilotd.service is not persistently enabled. Repair its default-target enrollment before retrying.")
    # ExecStartPre runs in the real unit, including administrator policy/drop-ins.
    try:
        isolation = json.loads((root / "coordinator-preflight.json").read_text())
    except (OSError, ValueError):
        raise Blocked("sandbox", "The actual service-policy coordinator preflight has no result. Inspect the unit's ExecStartPre and journal; do not substitute an SSH-shell probe or weaken global policy.")
    if isolation.get("available") is not True:
        manager = report.get("packagePlan", {}).get("manager")
        raise Blocked("sandbox", "The service is running, but coordinator isolation is unavailable. Install bubblewrap if missing, then review per-service namespace/AppArmor/SELinux/seccomp policy. Do not disable global security. After an explicit safe service restart, repeat setup.",
                      dict(capability=isolation, requiresPrivilege=True,
                           command=["sudo", manager, "install", "-y", "bubblewrap"] if manager else None))
    return dict(ok=True, identity=identity, service=state)


def setup(digest, size, pinned, stream):
    if platform.system() != "Linux" or platform.machine() != "x86_64" or os.getuid() == 0:
        raise Blocked("platform", "Use a dedicated non-root Linux x86-64 account.")
    home = Path.home().resolve(strict=True)
    if pinned and read_identity(home) != pinned:
        raise Blocked("identity", "The saved host identity differs or is missing. Explicitly repair pairing before setup.")
    base = home / ".local/share/pilot/runtimes"
    private_directory(base)
    descriptor = os.open(base / ".bootstrap.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked("busy", "Another setup is running. Wait for it, then repeat setup to reconcile its result.")
        # A lost SSH process may leave an unpublished upload. Only our marked private scratch is removed.
        for stale in base.glob(".stage-*"):
            marker = stale / ".bootstrap-stage"
            if (not stale.is_symlink() and stale.is_dir() and stale.stat().st_uid == os.getuid() and
                    not marker.is_symlink() and marker.is_file() and marker.read_text() == "pilot-bootstrap-v1"):
                shutil.rmtree(stale)
        # An earlier setup may have installed another Pilot runtime before the app saved this host.
        # Setup never switches runtimes; report the observed identity so the app can offer the update flow.
        installed = installed_runtime(home, base)
        identity = read_identity(home)
        if installed and installed != digest and identity:
            blocked = Blocked("update-required", "This devbox runs another Pilot runtime. Update it with the verified package; setup never switches runtimes.")
            blocked.result["identity"] = identity
            raise blocked
        root = stage(base, digest, size, stream)
        return activate(root, home)


def update(digest, size, pinned, metadata, stream):
    if platform.system() != "Linux" or platform.machine() != "x86_64" or os.getuid() == 0:
        raise Blocked("platform", "Use a dedicated non-root Linux x86-64 account.")
    home = Path.home().resolve(strict=True)
    if not pinned or read_identity(home) != pinned:
        raise Blocked("identity", "The saved host history differs. Update did not change the service.")
    base = home / ".local/share/pilot/runtimes"
    private_directory(base)
    descriptor = os.open(base / ".bootstrap.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked("busy", "Another setup or update owns this host. Check its status before retrying.")
        root = stage(base, digest, size, stream)
        # Keep a durable published package before any restart intent can become durable. This work
        # is in the SSH helper, never on the daemon event loop. Bounds were enforced during extraction.
        for directory, dirs, files in os.walk(root, followlinks=False):
            for name in files:
                file = Path(directory) / name
                if not file.is_symlink():
                    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
        for directory, dirs, files in os.walk(root, topdown=False, followlinks=False):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        for path in [root.parent / "complete", root.parent, base]:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        runner = root / "scripts/linux/update.mjs"
        if runner.is_symlink() or not runner.is_file():
            raise Blocked("assets", "This signed package has no safe updater. No service was changed.")
        # Archive hash was checked by this trusted app helper before executing package code. The runner
        # verifies the exact signed manifest against the app-provided trusted key again before journaling.
        result = command([str(root / "node/bin/node"), str(runner), "prepare", metadata], "update",
                         "The update could not be confirmed. Check the same transaction after reconnecting.", 120)
        return json.loads(result)


if __name__ == "__main__":
    try:
        digest, size, pinned = sys.argv[1:4]
        size = int(size)
        if not re.fullmatch(r"[a-f0-9]{64}", digest) or not 0 < size <= 536870912:
            raise Blocked("archive", "Invalid authenticated package coordinates.")
        if len(sys.argv) == 6 and sys.argv[4] == "update":
            result = update(digest, size, json.loads(pinned), sys.argv[5], sys.stdin.buffer)
        else:
            result = setup(digest, size, json.loads(pinned), sys.stdin.buffer)
    except Blocked as error:
        result = error.result
    except Exception:
        result = dict(ok=False, code="setup", detail="Setup could not reconcile private runtime/service state. No credentials/data were replaced. Inspect the owned service journal and retry the same package.")
    print(json.dumps(result), flush=True)
    sys.exit(0 if result.get("ok") else 2)
