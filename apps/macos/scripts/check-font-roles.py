#!/usr/bin/env python3
"""Keep app chrome on the Theme.TextRole scale.

Chrome text uses `.font(.pilot(...))`. Fixed `.system(size:)` fonts and SwiftUI text styles such as `.caption` or
`.headline` remain only in files listed in font-literals.txt, at most as many times as listed there. Lower or
remove a file's entry when you convert it; never raise one.
"""

import pathlib
import re
import sys

LITERAL = re.compile(
    r"\.system\(size: *[0-9]"
    r"|\.font\(\.(?:largeTitle|title|title2|title3|headline|subheadline|body|callout|footnote|caption|caption2)\b"
)
HERE = pathlib.Path(__file__).resolve().parent
SOURCES = HERE.parent / "Sources" / "Pilot"
BASELINE = HERE / "font-literals.txt"


def count(sources):
    counts = {}
    for path in sorted(pathlib.Path(sources).rglob("*.swift")):
        found = len(LITERAL.findall(path.read_text(encoding="utf-8")))
        if found:
            counts[path.relative_to(sources).as_posix()] = found
    return counts


def read_baseline(path):
    allowed = {}
    for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            name, limit = line.rsplit(None, 1)
            allowed[name] = int(limit)
    return allowed


def violations(counts, allowed):
    return [
        f"{name}: {found} fixed font size or text style use(s), {allowed.get(name, 0)} allowed"
        for name, found in sorted(counts.items())
        if found > allowed.get(name, 0)
    ]


def main(argv):
    sources = pathlib.Path(argv[1]) if len(argv) > 1 else SOURCES
    baseline = pathlib.Path(argv[2]) if len(argv) > 2 else BASELINE
    problems = violations(count(sources), read_baseline(baseline))
    if problems:
        print("Use .font(.pilot(...)) roles from Theme.TextRole instead of .system(size:) or SwiftUI text styles:",
              file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
