#!/usr/bin/env python3
"""Bind a CI app ZIP to its source commit before promoting it to a release."""

import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import sys
import zipfile

from release_metadata import stable_version, version


def checksum(path):
    # Production ZIPs are large. Never retain the archive in memory.
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_archive(archive, commit, app_version, env):
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid production source commit")
    stable_version(app_version)
    with zipfile.ZipFile(archive) as package:
        entry = package.getinfo("Pilot.app/Contents/Info.plist")
        if entry.file_size > 64 * 1024:
            raise ValueError("Unexpected production app metadata size")
        info = plistlib.loads(package.read(entry))
    if info.get("CFBundleShortVersionString") != app_version or "PilotRepoPath" in info:
        raise ValueError("Production app version or standalone metadata mismatch")
    build = version(info["CFBundleVersion"])
    for key, variable in (
        ("PilotUpdateRepository", "PILOT_UPDATE_REPOSITORY"),
        ("SUPublicEDKey", "SPARKLE_PUBLIC_KEY"),
        ("PilotLinuxRuntimePublicKey", "LINUX_RUNTIME_PUBLIC_KEY"),
    ):
        if not env.get(variable) or info.get(key) != env[variable]:
            raise ValueError(f"Production app does not match {variable}")
    return {
        "schemaVersion": 1,
        "commit": commit,
        "version": app_version,
        "buildVersion": build,
        "archive": {"name": archive.name, "size": archive.stat().st_size, "sha256": checksum(archive)},
    }


def production_artifact(action, directory, commit, app_version, env=None):
    env = os.environ if env is None else env
    archive = Path(directory) / "Pilot-arm64.zip"
    manifest = Path(directory) / "production-artifact.json"
    expected = inspect_archive(archive, commit, app_version, env)
    if action == "create":
        if expected["buildVersion"] != env.get("BUNDLE_VERSION"):
            raise ValueError("Production app does not match BUNDLE_VERSION")
        manifest.write_text(json.dumps(expected, indent=2) + "\n")
    elif action == "verify":
        if manifest.stat().st_size > 64 * 1024 or json.loads(manifest.read_text()) != expected:
            raise ValueError("Production artifact does not match the release source or archive")
    else:
        raise ValueError("Expected create or verify")


if __name__ == "__main__":
    production_artifact(*sys.argv[1:])
