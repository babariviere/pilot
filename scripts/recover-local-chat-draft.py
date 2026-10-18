#!/usr/bin/env python3
"""User-run, quit-app-only escape from a pending remote new-chat composer.

This does not cancel, retire, replay or modify any operation. The exact original
draft file is backed up privately before atomically changing only newTask context.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import uuid


def pilot_running():
    result = subprocess.run(["pgrep", "-x", "Pilot"], stdout=subprocess.DEVNULL)
    if result.returncode not in (0, 1):
        raise RuntimeError("Could not verify that Pilot is quit. Nothing was changed.")
    return result.returncode == 0


def read_private(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > limit:
            raise RuntimeError("Expected a bounded private file owned by you. Nothing was changed.")
        return stream.read(), (info.st_ino, info.st_mtime_ns)


def repair(root, *, running=pilot_running):
    root = Path(root)
    source = root / "Drafts/drafts.json"
    directory = source.parent
    if running():
        raise RuntimeError("Fully quit Pilot with Command-Q first, not just its window. Nothing was changed.")
    for folder in (root, directory, root / "Operations"):
        info = folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("Expected private app-owned directories. Nothing was changed.")
    original, identity = read_private(source, 16 * 1024 * 1024)
    drafts = json.loads(original)
    task = drafts.get("newTask")
    local = drafts.get("localHost")
    if drafts.get("version") != 1 or drafts.get("parkedNewTasks") or not isinstance(task, dict) or not isinstance(local, dict):
        raise RuntimeError("Unknown draft format or missing saved Local identity. Nothing was changed.")
    if local.get("hostId") != "local" or not all(isinstance(local.get(k), str) and local[k] for k in ("daemonId", "lineageId")):
        raise RuntimeError("No valid saved Local identity. Nothing was changed.")
    pending = task.get("pendingOperationId")
    if not isinstance(pending, str) or not pending:
        raise RuntimeError("This draft has no pending operation. Nothing was changed.")
    files = list((root / "Operations").glob("*.json"))
    if len(files) > 512:
        raise RuntimeError("Too many operation files to inspect safely. Nothing was changed.")
    matches = []
    for file in files:
        data, _ = read_private(file, 512 * 1024)
        value = json.loads(data)
        if value.get("operationId") == pending:
            matches.append((file, data, value))
    if len(matches) != 1:
        raise RuntimeError("Cannot identify the exact original operation. Nothing was changed.")
    operation_file, operation_bytes, operation = matches[0]
    destination = operation.get("destination")
    if (operation.get("schemaVersion") != 1 or operation.get("kind") not in ("chat-create", "chat-create-attached")
            or operation.get("origin") != local or not isinstance(destination, dict)
            or destination.get("hostId") in (None, "", "local") or destination != task.get("executionHost")
            or not operation.get("targetId")
            or hashlib.sha256(operation["payload"].encode("utf-8")).hexdigest() != operation.get("payloadHash")):
        raise RuntimeError("Pending operation/pin/hash does not match this remote draft. Nothing was changed.")
    repaired = copy.deepcopy(drafts)
    new_task = repaired["newTask"]
    new_task.update(executionHost=copy.deepcopy(local), pendingOperationId=None, projectId=None,
                    folder="", model="", workspace=None, mission=None, trackedItem=None,
                    branchScope=None, baseBranch=None, pendingBaseBranch=None, pendingMessage=None,
                    pendingCwd=None, pendingWorkspace=None, runningTab=False)
    # Message, attachments and every other draft/top-level value are intentionally untouched.
    output = (json.dumps(repaired, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    backup = directory / ("drafts.before-local-" + uuid.uuid4().hex + ".json")
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(original)
        stream.flush()
        os.fsync(stream.fileno())
    temp = None
    try:
        fd, name = tempfile.mkstemp(prefix=".local-draft-", dir=directory)
        temp = Path(name)
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(output)
            stream.flush()
            os.fsync(stream.fileno())
        current, current_identity = read_private(source, 16 * 1024 * 1024)
        if running() or current != original or current_identity != identity or read_private(operation_file, 512 * 1024)[0] != operation_bytes:
            raise RuntimeError("Pilot or its saved state changed. Original draft was NOT replaced; the private backup remains.")
        os.replace(temp, source)
        temp = None
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)
    return backup


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.home() / "Library/Application Support/Pilot")
    args = parser.parse_args()
    try:
        backup = repair(args.root)
        print("Local composer restored. Relaunch Pilot and choose your Local project.")
        print("Exact private backup:", backup)
        print("The pending remote operation was not changed, cancelled or resent.")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        raise SystemExit(str(error))
