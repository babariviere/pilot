"""Provision the Day-only updater secret. Never sign, dispatch or publish a release."""

import base64
import json
import os
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

REPO = "babariviere/pilot"
SECRET = "DAY_UPDATER_PRIVATE_KEY"
CONFIG = Path(__file__).resolve().parents[1] / "fnox.toml"


def run(args, *, data=None):
    # Child errors may contain credentials. Report only the operation, never output.
    result = subprocess.run(
        args, input=data, capture_output=True, timeout=60, check=False
    )
    if result.returncode:
        raise ValueError("Failed operation: " + args[0])
    return result.stdout


def verify_key(key, public):
    expected = base64.b64decode(public.strip(), validate=True)
    if len(expected) != 32:
        raise ValueError("Expected the existing raw Ed25519 public key")
    der = run(["openssl", "pkey", "-pubout", "-outform", "DER"], data=key)
    if der != bytes.fromhex("302a300506032b6570032100") + expected:
        raise ValueError("Updater key does not match the repository public key")


def main():
    if sys.argv[1:] != ["--write"]:
        raise ValueError("Explicit --write required; no signing or workflow dispatch")
    repo = json.loads(
        run(["gh", "repo", "view", REPO, "--json", "nameWithOwner,viewerPermission"])
    )
    if repo["nameWithOwner"] != REPO or repo["viewerPermission"] != "ADMIN":
        raise ValueError("Expected administrator access to the configured repository")
    # No environment fallback or global fnox layer may supply the signing key.
    config = tomllib.loads(CONFIG.read_text())
    entry = config["secrets"][SECRET]
    if entry.get("provider") != "age" or not entry.get("value"):
        raise ValueError(
            "Import the verified existing key into fnox age configuration first"
        )
    with tempfile.TemporaryDirectory(prefix="day-fnox-") as isolated:
        env = dict(os.environ, FNOX_CONFIG_DIR=isolated)
        env.pop(SECRET, None)
        result = subprocess.run(
            [
                "fnox",
                "--no-daemon",
                "--non-interactive",
                "-c",
                str(CONFIG),
                "get",
                SECRET,
            ],
            env=env,
            capture_output=True,
            timeout=60,
            check=False,
        )
        if result.returncode or not result.stdout.strip():
            raise ValueError("Could not decrypt the configured age ciphertext")
        key = result.stdout
    public = run(
        ["gh", "variable", "get", "PILOT_NEXT_UPDATER_PUBLIC_KEY", "--repo", REPO]
    )
    verify_key(key, public)
    # stdin, not argv, disk, shell tracing or logs. Never automatically retry a write.
    try:
        result = subprocess.run(
            ["gh", "secret", "set", SECRET, "--repo", REPO],
            input=key,
            capture_output=True,
            timeout=60,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        raise ValueError(
            "Unknown write outcome for " + SECRET + "; do not replay"
        ) from None
    if result.returncode:
        raise ValueError(
            "Unacknowledged write for " + SECRET + "; treat as Unknown, do not replay"
        )
    print("Acknowledged GitHub write: " + REPO + " / " + SECRET)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, subprocess.TimeoutExpired, OSError):
        # No exception payloads: parsers and process errors can include secret input.
        print(
            "Signing provisioning failed or is Unknown. Check access, encrypted configuration and write acknowledgment; do not blindly retry.",
            file=sys.stderr,
        )
        sys.exit(1)
