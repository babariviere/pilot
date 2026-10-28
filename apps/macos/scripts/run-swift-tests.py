#!/usr/bin/env python3
"""Bound one SwiftPM invocation, excluding compilation from the test deadline.

On timeout, sample only processes in our private session, then kill its groups.
"""

import argparse
import os
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time


def owned_processes(session):
    result = subprocess.run(["ps", "-axo", "pid=,pgid=,comm="],
                            capture_output=True, text=True, timeout=5, check=True)
    owned = []
    for line in result.stdout.splitlines():
        pid, group, command = line.strip().split(None, 2)
        try:
            # SwiftPM/Foundation can create another process group for a helper.
            # Session membership also catches those helpers after the driver exits.
            if os.getsid(int(pid)) == session:
                owned.append((int(pid), int(group), command))
        except (ProcessLookupError, PermissionError):
            pass
    return owned


def diagnose(session):
    if sys.platform != "darwin":
        return
    try:
        owned = []
        for pid, _group, command in owned_processes(session):
            print(f"[swift-watchdog] PID {pid}: {command}", file=sys.stderr, flush=True)
            if "swiftpm-testing-helper" in command or "xctest" in command:
                owned.append(pid)
        # Sample the runner rather than just the SwiftPM driver waiting for it.
        for pid in (owned or [session])[:3]:
            with tempfile.TemporaryFile() as output:
                subprocess.run(["sample", str(pid), "1", "1"], stdout=output,
                               stderr=subprocess.STDOUT, timeout=5, check=False)
                output.seek(0)
                sys.stderr.buffer.write(output.read(128 * 1024))
                sys.stderr.flush()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"[swift-watchdog] could not sample runner: {error}", file=sys.stderr, flush=True)


def cleanup_session(process):
    # Even if the driver exited, a descendant may still hold stdout.
    groups = set()
    try:
        # killpg(0) targets *our* group, not a child. Reject special groups and
        # the supervisor's group even if a process-table snapshot contains them.
        groups.update(group for _pid, group, _command in owned_processes(process.pid)
                      if group > 1 and group != os.getpgrp())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"[swift-watchdog] could not list helper groups: {error}", file=sys.stderr, flush=True)
    for group in groups:
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError as error:
            print(f"[swift-watchdog] could not kill group {group}: {error}", file=sys.stderr, flush=True)
    # Popen checks/reaps its direct child before signalling it, avoiding PID reuse.
    if process.poll() is None:
        process.kill()
    process.wait()


def run(command, build_timeout, test_timeout):
    started = time.monotonic()
    phase = "build/startup"
    deadline = started + build_timeout
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True)

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    previous_signals = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
    pending = b""
    timed_out = False
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    print(f"error: Swift {phase} exceeded its deadline "
                          f"({test_timeout if phase == 'tests' else build_timeout:g}s)",
                          file=sys.stderr, flush=True)
                    diagnose(process.pid)
                    break
                if not selector.select(min(remaining, 0.25)):
                    continue
                chunk = os.read(process.stdout.fileno(), 64 * 1024)
                if not chunk:
                    selector.unregister(process.stdout)
                    break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                pending += chunk
                lines = pending.split(b"\n")
                pending = lines.pop()[-4096:]
                for line in lines:
                    clean = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", line).strip()
                    if clean.startswith(("◇ Test run started.".encode(), b"Test Suite 'All tests' started at ")):
                        phase = "tests"
                        deadline = time.monotonic() + test_timeout
            # A driver can close stdout but remain stuck during shutdown.
            if not timed_out:
                try:
                    process.wait(timeout=max(0, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    timed_out = True
                    print("error: Swift driver did not exit before its deadline", file=sys.stderr, flush=True)
                    diagnose(process.pid)
    finally:
        # A second cancellation must not interrupt reaping the first one's children.
        for sig in previous_signals:
            signal.signal(sig, signal.SIG_IGN)
        cleanup_session(process)
        process.stdout.close()
        for sig, handler in previous_signals.items():
            signal.signal(sig, handler)
        print(f"[swift-watchdog] invocation finished in {time.monotonic() - started:.1f}s",
              file=sys.stderr, flush=True)
    return 124 if timed_out else (process.returncode if process.returncode >= 0 else 128 - process.returncode)


def positive_seconds(value):
    seconds = float(value)
    if not 0 < seconds < float("inf"):
        raise argparse.ArgumentTypeError("deadline must be a finite positive number")
    return seconds


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-timeout", type=positive_seconds, default=600)
    parser.add_argument("--test-timeout", type=positive_seconds, default=180)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required after --")
    return run(command, args.build_timeout, args.test_timeout)


if __name__ == "__main__":
    sys.exit(main())
