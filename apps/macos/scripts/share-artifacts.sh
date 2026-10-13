#!/usr/bin/env bash
# Resolve Swift packages, then share their binary artifacts (libghostty, Sparkle) between checkouts.
#
# Every checkout extracts the same ~200 MB of xcframeworks into its own .build/artifacts. Pilot
# creates one checkout per session, so this adds up quickly. After SwiftPM resolves and verifies an
# artifact, keep one copy per checksum in a shared cache and replace the checkout's copy with an
# APFS clone of it. Clones share disk blocks until written, and a write only changes that checkout.
# Without clone support (another volume or file system) the checkout keeps its own copy.
#
# PILOT_SWIFT_SHARE_ARTIFACTS=0 disables sharing. PILOT_SWIFT_ARTIFACT_CACHE overrides the cache path.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
swift package --package-path "$here" resolve
[ "${PILOT_SWIFT_SHARE_ARTIFACTS:-1}" = 1 ] || exit 0
python3 - "$here/.build" "${PILOT_SWIFT_ARTIFACT_CACHE:-$HOME/Library/Caches/pilot/swift-artifacts}" <<'PY'
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

build, cache = (os.path.realpath(path) for path in sys.argv[1:3])
try:
    with open(os.path.join(build, "workspace-state.json")) as handle:
        artifacts = json.load(handle)["object"]["artifacts"]
except (OSError, KeyError, ValueError):
    sys.exit(0)
root = os.path.join(build, "artifacts")
markers = os.path.join(build, "pilot-shared-artifacts")


def clone(source, destination):
    """Clone a directory tree with clonefile(2), preserving modes and times."""
    result = subprocess.run(["cp", "-c", "-Rp", source + "/.", destination], stderr=subprocess.PIPE)
    if result.returncode != 0:
        print(f"warning: not sharing Swift artifacts: {result.stderr.decode().strip()}", file=sys.stderr)
    return result.returncode == 0


for artifact in artifacts:
    source = artifact.get("source") or {}
    checksum = source.get("checksum", "")
    if source.get("type") != "remote" or not re.fullmatch(r"[0-9a-f]{64}", checksum):
        continue
    # SwiftPM extracts each target to artifacts/<package>/<target>/<name>.xcframework.
    directory = os.path.dirname(os.path.realpath(artifact.get("path", "")))
    if os.path.dirname(os.path.dirname(directory)) != root or not os.path.isdir(directory):
        continue
    marker = os.path.join(markers, checksum)
    inode = str(os.stat(directory).st_ino)
    try:
        with open(marker) as handle:
            if handle.read() == inode:
                continue
    except OSError:
        pass
    shared = os.path.join(cache, checksum)
    if not os.path.isdir(shared):
        os.makedirs(cache, exist_ok=True)
        staging = tempfile.mkdtemp(prefix=".staging-", dir=cache)
        if not clone(directory, staging):
            shutil.rmtree(staging, ignore_errors=True)
            break
        try:
            os.rename(staging, shared)
        except OSError:
            # Another checkout published the same checksum first.
            shutil.rmtree(staging, ignore_errors=True)
    replacement = tempfile.mkdtemp(prefix=".pilot-shared-", dir=os.path.dirname(directory))
    if not clone(shared, replacement):
        shutil.rmtree(replacement, ignore_errors=True)
        break
    previous = directory + ".pilot-previous"
    shutil.rmtree(previous, ignore_errors=True)
    os.rename(directory, previous)
    os.rename(replacement, directory)
    shutil.rmtree(previous)
    os.makedirs(markers, exist_ok=True)
    with open(marker, "w") as handle:
        handle.write(str(os.stat(directory).st_ino))
PY
