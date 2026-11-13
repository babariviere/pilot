#!/usr/bin/env python3
"""Admit only unsigned exact-source Main/PR qualification on hosted CI."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def validate(source, environment, event, head):
    if not re.fullmatch(r"[0-9a-f]{40}", source) or source != environment.get("GITHUB_SHA") or source != head:
        raise ValueError("Qualification requires the exact immutable event and checkout SHA")
    repository = event.get("repository", {})
    name = environment.get("GITHUB_REPOSITORY")
    if not name or repository.get("full_name") != name or repository.get("fork") is not False:
        raise ValueError("Qualification requires the non-fork caller repository")
    kind, ref = environment.get("GITHUB_EVENT_NAME"), environment.get("GITHUB_REF")
    if kind == "push" and ref == "refs/heads/main":
        return
    pr = event.get("pull_request", {})
    if (kind == "pull_request" and type(event.get("number")) is int
            and ref == f"refs/pull/{event['number']}/merge"
            and pr.get("base", {}).get("ref") == "main"
            and pr.get("base", {}).get("repo", {}).get("full_name") == name
            and pr.get("head", {}).get("repo", {}).get("full_name") == name):
        return
    raise ValueError("Only Main pushes and same-repository PR merge checks are supported")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    args = parser.parse_args()
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    validate(args.source, os.environ, event, head)


if __name__ == "__main__":
    main()
