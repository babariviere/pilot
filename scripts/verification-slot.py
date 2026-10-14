#!/usr/bin/env python3
"""Run a heavy check in a per-machine slot (macOS/Linux, Python stdlib only).

The lock file is permanent; its *kernel lock*, never its JSON/PID/age, owns the
slot. exec keeps the locked descriptor alive, so crashes need no stale-PID
heuristics and a killed launcher cannot free a still-running check's slot.
"""

import argparse
import fcntl
import json
import os
from pathlib import Path
import sys
import time


DEFAULTS = {"swift": 1, "node": 2}
REPORT_SECONDS = 15


def verification_root():
    data = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local/share")
    home = os.environ.get("PILOT_HOME") or str(Path(data) / "pilot")
    return Path(home).resolve() / "verification"


def limits(root):
    try:
        config = json.loads((root / "limits.json").read_text())
    except FileNotFoundError:
        config = {}
    if not isinstance(config, dict) or set(config) - set(DEFAULTS):
        raise ValueError("limits.json must be an object with only swift and/or node limits")
    result = {**DEFAULTS, **config}
    for group, count in result.items():
        if type(count) is not int or not 1 <= count <= 64:
            raise ValueError(f"limits.json: {group} must be an integer from 1 to 64")
    return result


def holder(fd, slot):
    # A new owner may be between flock and writing metadata. This never permits
    # reclaiming its lock. Bounded reads and quoted paths keep diagnostics safe.
    try:
        record = json.loads(os.pread(fd, 4096, 0))
        age = max(0, int(time.time() - record["startedAt"]))
        cwd = json.dumps(str(record["cwd"])[-240:])
        command = json.dumps(str(record["command"])[:80])
        return f"slot {slot}: PID {record['pid']}, {command}, cwd {cwd}, held {age}s"
    except (ValueError, KeyError, TypeError):
        return f"slot {slot}: holder starting (metadata pending)"


def acquire(root, group, count, command):
    directory = root / group
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    started = time.monotonic()
    report_at = started
    while True:
        holders = []
        for slot in range(1, count + 1):
            # Never unlink/replace a slot file, even after a crash: doing so
            # would allow two processes to lock different inodes for one slot.
            fd = os.open(directory / f"{slot}.lock", os.O_CREAT | os.O_RDWR, 0o600)
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    holders.append(holder(fd, slot))
                    continue
                record = {"pid": os.getpid(), "startedAt": time.time(),
                          "cwd": os.getcwd(), "command": Path(command[0]).name}
                data = json.dumps(record).encode()
                os.ftruncate(fd, 0)
                os.write(fd, data)
                os.set_inheritable(fd, True)
                waited = int(time.monotonic() - started)
                print(f"[verification:{group}] acquired slot {slot}/{count}, PID {os.getpid()} "
                      f"(waited {waited}s)", file=sys.stderr, flush=True)
                return fd
            finally:
                # Keep only the successful descriptor open across exec.
                if not os.get_inheritable(fd):
                    os.close(fd)
        now = time.monotonic()
        if now >= report_at:
            print(f"[verification:{group}] waiting {int(now - started)}s for a slot ({count} total); "
                  + "; ".join(holders), file=sys.stderr, flush=True)
            report_at = now + REPORT_SECONDS
        time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("group", choices=DEFAULTS)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        parser.error("a command is required after --")
    root = verification_root()
    count = limits(root)[args.group]
    fd = acquire(root, args.group, count, command)
    # Swift entry scripts re-exec themselves once through this runner. The PID
    # stays unchanged through exec; children have a different PID and cannot
    # accidentally inherit a bypass. This is internal, not a user override.
    os.environ[f"PILOT_VERIFICATION_{args.group.upper()}_PID"] = str(os.getpid())
    try:
        os.execvpe(command[0], command, os.environ)
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, ValueError) as error:
        print(f"[verification] {error}", file=sys.stderr)
        sys.exit(1)
