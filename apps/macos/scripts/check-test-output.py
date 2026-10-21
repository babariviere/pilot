#!/usr/bin/env python3
"""Stream Swift output unchanged and reject failed or incomplete test runners.

SwiftPM on CLT 27 may lose an earlier target's failure status, or a runner may
record a failed expectation and omit its terminal summary. Do not inspect
warning/diagnostic prose or trust the aggregate exit status.
"""

import argparse
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time


ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
SWIFT_FAILURE = re.compile(r"^✘ Test run with \d+ tests?(?: in \d+ suites?)? failed after ")
SWIFT_START = re.compile(r"^◇ Test run started\.")
SWIFT_TERMINAL = re.compile(r"^[✔✘] Test run with \d+ tests?(?: in \d+ suites?)? (?:passed|failed) after ")
SWIFT_RECORDED_FAILURE = re.compile(r"^✘ Test .+ recorded an issue:")
XCTEST_START = re.compile(r"^Test Suite 'All tests' started at ")
XCTEST_FAILURE = re.compile(r"^Test Suite '.+' failed at ")
XCTEST_TERMINAL = re.compile(r"^Test Suite 'All tests' (?:passed|failed) at ")


def failed_summary(line):
    line = ANSI.sub("", line).strip()
    return bool(SWIFT_FAILURE.match(line) or XCTEST_FAILURE.match(line))


def descendant_processes(table, parent):
    """Only this pipeline's processes, never another checkout's Swift processes."""
    processes = []
    for line in table.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3 and fields[0].isdigit() and fields[1].isdigit():
            processes.append((int(fields[0]), int(fields[1]), Path(fields[2]).name))
    descendants = {parent}
    while True:
        found = descendants | {pid for pid, ppid, _ in processes if ppid in descendants}
        if found == descendants:
            break
        descendants = found
    return sorted((pid, name) for pid, _, name in processes if pid in descendants and pid != parent)


def descendant_runners(table, parent):
    names = {"swiftpm-testing", "swift-testing-helper", "xctest"}
    return [pid for pid, name in descendant_processes(table, parent)
            if name in names or name.endswith("PackageTests") or name.endswith("Tests.xctest")][:2]


def sample_stalled_runners(parent):
    """Best-effort, bounded diagnostics. Never terminate or change a test's result."""
    try:
        # CI may set a narrow COLUMNS value. Without -ww, the executable's basename can be truncated.
        table = subprocess.run(["/bin/ps", "-wwaxo", "pid=,ppid=,comm="], check=True,
                               capture_output=True, text=True, timeout=5).stdout
        runners = descendant_runners(table, parent)
        print(f"Swift test output stalled; sampling runner PIDs: {runners}", file=sys.stderr, flush=True)
        if not runners:
            own = descendant_processes(table, parent)[:32]
            print(f"Swift stall owner PID: {parent}; descendant names: {own}", file=sys.stderr, flush=True)
        directory = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / "swift-test-stalls"
        directory.mkdir(parents=True, exist_ok=True)
        for pid in runners:
            path = directory / f"runner-{os.getpid()}-{pid}.sample.txt"
            try:
                subprocess.run(["/usr/bin/sample", str(pid), "2", "-file", str(path)],
                               check=True, capture_output=True, timeout=10)
                with path.open() as source:
                    excerpt = source.read(24000)
                print(f"== Swift stall sample: {path.name} ==\n{excerpt}", file=sys.stderr, flush=True)
            except (OSError, subprocess.SubprocessError) as error:
                print(f"Swift stall sample unavailable: {type(error).__name__}", file=sys.stderr, flush=True)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"Swift stall discovery unavailable: {type(error).__name__}", file=sys.stderr, flush=True)


class StallSampler:
    def __init__(self, seconds, capture, clock=time.monotonic):
        self.seconds, self.capture, self.clock = seconds, capture, clock
        self.condition = threading.Condition()
        self.active = self.stopped = self.sampled = False
        self.deadline = 0
        self.thread = threading.Thread(target=self.watch, daemon=True)

    def progress(self, active):
        with self.condition:
            self.active = active
            self.deadline = self.clock() + self.seconds
            self.condition.notify_all()

    def capture_if_due(self):
        with self.condition:
            if self.stopped or self.sampled or not self.active or self.clock() < self.deadline:
                return False
            self.sampled = True
        self.capture()
        return True

    def watch(self):
        while True:
            with self.condition:
                if self.stopped:
                    return
                if self.sampled or not self.active:
                    self.condition.wait()
                    continue
                remaining = self.deadline - self.clock()
                if remaining > 0:
                    self.condition.wait(remaining)
                    continue
            self.capture_if_due()

    def close(self):
        with self.condition:
            self.stopped = True
            self.condition.notify_all()
        if self.thread.is_alive():
            self.thread.join(timeout=26)  # ps (5s), at most two samples (10s each).


def check_output(source, output, diagnostics, required_tests=(), *, sampler=None):
    required = {name: re.compile(r"^◇ Test " + re.escape(name) + r"\(") for name in required_tests}
    seen_required = set()
    failed = False
    started = 0
    terminal = 0
    for line in source:
        output.write(line)
        output.flush()
        decoded = ANSI.sub("", line.decode("utf-8", errors="replace")).strip()
        for name, pattern in required.items():
            if pattern.match(decoded):
                seen_required.add(name)
        failed |= failed_summary(decoded) or bool(SWIFT_RECORDED_FAILURE.match(decoded))
        if SWIFT_START.match(decoded) or XCTEST_START.match(decoded):
            started += 1
        if SWIFT_TERMINAL.match(decoded) or XCTEST_TERMINAL.match(decoded):
            terminal += 1
        if sampler:
            sampler.progress(terminal < started)
    incomplete = terminal < started
    if incomplete:
        print(f"error: {started - terminal} native test runner(s) started without a terminal summary", file=diagnostics)
    if failed:
        print("error: a native test target failed (see runner summary above)", file=diagnostics)
    missing = required.keys() - seen_required
    for name in sorted(missing):
        print(f"error: required native test did not start: {name}", file=diagnostics)
    return int(failed or incomplete or bool(missing))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-test", action="append", default=[],
                        help="Fail if this Swift Testing function did not start (repeatable)")
    parser.add_argument("--sample-stalled-after", type=float,
                        help="Capture one bounded live stack after this many seconds without test output")
    parser.add_argument("--runner-parent-pid", type=int, default=os.getppid(),
                        help="Owning wrapper PID, explicit to survive shell pipeline reparenting")
    args = parser.parse_args()
    if args.sample_stalled_after is not None and (not math.isfinite(args.sample_stalled_after)
                                                 or args.sample_stalled_after <= 0):
        parser.error("--sample-stalled-after must be finite and positive")
    if args.runner_parent_pid <= 0:
        parser.error("--runner-parent-pid must be positive")
    sampler = None
    if args.sample_stalled_after is not None:
        parent = args.runner_parent_pid
        sampler = StallSampler(args.sample_stalled_after, lambda: sample_stalled_runners(parent))
        sampler.thread.start()
    try:
        return check_output(sys.stdin.buffer, sys.stdout.buffer, sys.stderr, args.require_test, sampler=sampler)
    finally:
        if sampler:
            sampler.close()


if __name__ == "__main__":
    sys.exit(main())
