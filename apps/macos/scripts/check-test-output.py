#!/usr/bin/env python3
"""Stream Swift output unchanged and reject failed or incomplete test runners.

SwiftPM on CLT 27 may lose an earlier target's failure status, or a runner may
record a failed expectation and omit its terminal summary. Do not inspect
warning/diagnostic prose or trust the aggregate exit status.
"""

import re
import sys


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


def main():
    failed = False
    started = 0
    terminal = 0
    for line in sys.stdin.buffer:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
        decoded = ANSI.sub("", line.decode("utf-8", errors="replace")).strip()
        failed |= failed_summary(decoded) or bool(SWIFT_RECORDED_FAILURE.match(decoded))
        if SWIFT_START.match(decoded) or XCTEST_START.match(decoded):
            started += 1
        if SWIFT_TERMINAL.match(decoded) or XCTEST_TERMINAL.match(decoded):
            terminal += 1
    incomplete = terminal < started
    if incomplete:
        print(f"error: {started - terminal} native test runner(s) started without a terminal summary", file=sys.stderr)
    if failed:
        print("error: a native test target failed (see runner summary above)", file=sys.stderr)
    return int(failed or incomplete)


if __name__ == "__main__":
    sys.exit(main())
