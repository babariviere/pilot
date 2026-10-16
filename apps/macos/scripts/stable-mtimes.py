#!/usr/bin/env python3
"""Give every file under the Swift package a timestamp derived from its contents. CI only.

A fresh checkout stamps every file with the current time, so a restored .build looks stale and
Swift recompiles everything. SwiftPM and the Swift driver treat an input as unchanged when its
timestamp equals the one recorded by the previous build. A content-derived timestamp is the same
on every runner for the same bytes and differs when the bytes change, so only edited inputs
recompile. Local checkouts keep their real timestamps; do not run this outside CI.
"""

import hashlib
import os
from pathlib import Path
import sys

# 2000-01-01. Every stamp is far older than any recorded build, so none looks newer than its products.
EPOCH = 946_684_800
# About 9.5 years of seconds. Two different contents share a stamp with probability about 3e-9.
SPAN = 300_000_000
# Build products, never inputs.
SKIP = {".build", "build"}


def stamp(data: bytes) -> int:
    return EPOCH + int.from_bytes(hashlib.sha256(data).digest()[:8], "big") % SPAN


def contents(path: str) -> bytes:
    if os.path.islink(path):
        return b"link:" + os.fsencode(os.readlink(path))
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.digest()


def stabilize(root: Path) -> int:
    count = 0
    for directory, names, files in os.walk(root):
        if Path(directory) == root:
            names[:] = [name for name in names if name not in SKIP]
        for name in files:
            path = os.path.join(directory, name)
            when = stamp(contents(path))
            os.utime(path, (when, when), follow_symlinks=False)
            count += 1
    return count


if __name__ == "__main__":
    root = Path(sys.argv[1]).resolve()
    print(f"Stamped {stabilize(root)} files under {root}")
