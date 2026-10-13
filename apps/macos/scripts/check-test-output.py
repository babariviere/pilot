#!/usr/bin/env python3
"""Stream Swift output unchanged and reject failed runner summaries.

SwiftPM on CLT 27 may lose an earlier target's failure status. Do not inspect
warning/diagnostic prose or trust the last summary: each target runs separately.
The shell's pipefail remains responsible for nonzero Swift driver exits.
"""

import re
import sys


ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
SWIFT_FAILURE = re.compile(r"^✘ Test run with \d+ tests?(?: in \d+ suites?)? failed after ")
XCTEST_FAILURE = re.compile(r"^Test Suite '.+' failed at ")


def failed_summary(line):
    line = ANSI.sub("", line).strip()
    return bool(SWIFT_FAILURE.match(line) or XCTEST_FAILURE.match(line))


def main():
    failed = False
    for line in sys.stdin.buffer:
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()
        failed |= failed_summary(line.decode("utf-8", errors="replace"))
    if failed:
        print("error: a native test target failed (see runner summary above)", file=sys.stderr)
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
