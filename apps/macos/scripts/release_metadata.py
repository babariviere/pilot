#!/usr/bin/env python3
"""Dependency-free release metadata and relocatability checks."""

import argparse
import base64
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import xml.etree.ElementTree as ET

SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"
ET.register_namespace("sparkle", SPARKLE)
# Every platform's assets must be on the draft before it is published.
DRAFT_ASSETS = (
    "Pilot-arm64.zip",
    "appcast.xml",
    "Pilot-Next-macos-arm64.zip",
    "desktop-macos-arm64-update.json",
    "Pilot-Next-linux-x64.zip",
    "desktop-linux-x64-update.json",
)


def repository(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", value):
        raise ValueError("PilotUpdateRepository must be owner/repo")
    return value


def version(value):
    if not re.fullmatch(r"[1-9][0-9]*(?:\.[0-9]+){0,2}", value):
        raise ValueError("CFBundleVersion must be a positive numeric version (e.g. run_number.run_attempt)")
    return value


def base64_bytes(value, length):
    if len(base64.b64decode(value, validate=True)) != length:
        raise ValueError(f"Expected {length} base64-encoded bytes")
    return value


def stable_version(value):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value):
        raise ValueError("App version must be a stable semantic version (e.g. 0.2.0)")
    return value


def release_state(release):
    if release["isPrerelease"] or not release["isDraft"]:
        raise ValueError("Only stable drafts can be published")
    return "draft"


def complete_draft(release):
    release_state(release)
    uploaded = {a["name"] for a in release["assets"] if a["state"] == "uploaded"}
    missing = [name for name in DRAFT_ASSETS if name not in uploaded]
    if missing:
        raise ValueError("Draft is missing uploaded assets: " + ", ".join(missing))
    return "complete"


def appcast_build(appcast, app_version):
    item = ET.parse(appcast).find("channel/item")
    if item is None:
        raise ValueError("Draft appcast has no item")
    short = item.find(f"{{{SPARKLE}}}shortVersionString")
    if short is None or short.text != stable_version(app_version):
        raise ValueError("Draft appcast does not match the release version")
    build = item.find(f"{{{SPARKLE}}}version")
    if build is None or not build.text:
        raise ValueError("Draft appcast is missing its Sparkle build version")
    return version(build.text)
def write_plist(source, destination, repo_path, release=False, env=None, app_version=None):
    env = os.environ if env is None else env
    with open(source, "rb") as handle:
        info = plistlib.load(handle)
    if app_version is not None:
        info["CFBundleShortVersionString"] = stable_version(app_version)
    if env.get("RELEASE_KIND", "stable") != "stable":
        raise ValueError("Only stable release versions are supported")
    if release:
        info.pop("PilotRepoPath", None)
        for key in ("PILOT_UPDATE_REPOSITORY", "SPARKLE_PUBLIC_KEY", "BUNDLE_VERSION"):
            if not env.get(key):
                raise ValueError(f"{key} is required for BUNDLE_RUNTIME=1")
    else:
        info["PilotRepoPath"] = str(repo_path)
    if env.get("PILOT_UPDATE_REPOSITORY"):
        info["PilotUpdateRepository"] = repository(env["PILOT_UPDATE_REPOSITORY"])
    if env.get("SPARKLE_PUBLIC_KEY"):
        info["SUPublicEDKey"] = base64_bytes(env["SPARKLE_PUBLIC_KEY"], 32)
    info.pop("PilotLinuxRuntimePublicKey", None)
    if env.get("BUNDLE_VERSION"):
        info["CFBundleVersion"] = version(env["BUNDLE_VERSION"])
    with open(destination, "wb") as handle:
        plistlib.dump(info, handle, sort_keys=False)


def appcast(repo, asset_id, build_version, short_version, signature, length, minimum_os="14.0"):
    repository(repo)
    version(build_version)
    base64_bytes(signature, 64)
    if not re.fullmatch(r"[1-9][0-9]*", str(asset_id)) or int(length) <= 0:
        raise ValueError("Asset ID and archive length must be positive integers")
    rss = ET.Element("rss", version="2.0")
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = "Pilot (Apple Silicon)"
    item = ET.SubElement(channel, "item")
    ET.SubElement(item, "title").text = f"Pilot {short_version} ({build_version})"
    ET.SubElement(item, f"{{{SPARKLE}}}version").text = build_version
    ET.SubElement(item, f"{{{SPARKLE}}}shortVersionString").text = short_version
    ET.SubElement(item, f"{{{SPARKLE}}}minimumSystemVersion").text = minimum_os
    # The app authenticates both the feed and this exact API asset URL with its Keychain token.
    ET.SubElement(item, "enclosure", {
        "url": f"https://api.github.com/repos/{repo}/releases/assets/{asset_id}",
        f"{{{SPARKLE}}}edSignature": signature,
        "length": str(length),
        "type": "application/octet-stream",
    })
    ET.indent(rss)
    return ET.tostring(rss, encoding="utf-8", xml_declaration=True) + b"\n"


def validate_symlinks(root):
    root = Path(root).resolve()
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                if os.path.isabs(os.readlink(path)):
                    raise ValueError(f"Absolute runtime symlink: {path}")
                target = path.resolve(strict=True)
                if not target.is_relative_to(root):
                    raise ValueError(f"Runtime symlink escapes bundle: {path}")


def prepare_runtime(root):
    """Trim build-only metadata and non-arm64 prebuilds in isolated staging before signing."""
    root = Path(root)
    for directory, dirs, files in os.walk(root, followlinks=False):
        if Path(directory).name == "prebuilds":
            for name in list(dirs):
                if name != "darwin-arm64":
                    shutil.rmtree(Path(directory) / name)
                    dirs.remove(name)
        # Node/tsx execute the source, not declaration files. esbuild does not need input
        # source maps to produce the minified browser bundles we ship without output maps.
        for name in files:
            if name.endswith((".map", ".d.ts", ".d.mts", ".d.cts")):
                path = Path(directory) / name
                if not path.is_symlink() and path.is_file():
                    path.unlink()
    for helper in root.rglob("spawn-helper"):
        if helper.is_file():
            helper.chmod(0o755)


def newer_than_latest(app_version, latest_tag):
    current = tuple(map(int, stable_version(app_version).split(".")))
    if not latest_tag:
        return True
    # One-way migration from the former workflow-build tags to stable version tags.
    if latest_tag.startswith("pilot-"):
        version(latest_tag.removeprefix("pilot-"))
        return True
    if not latest_tag.startswith("v"):
        raise ValueError("Latest release has an unrecognized tag; refusing to change latest")
    latest = tuple(map(int, stable_version(latest_tag.removeprefix("v")).split(".")))
    return current > latest


def newer_build_than_latest(build_version, latest_appcast):
    item = ET.parse(latest_appcast).find("channel/item")
    latest = None if item is None else item.find(f"{{{SPARKLE}}}version")
    if latest is None or not latest.text:
        raise ValueError("Latest appcast is missing its Sparkle build version")

    def parts(value):
        values = tuple(map(int, version(value).split(".")))
        return values + (0,) * (3 - len(values))

    return parts(build_version) > parts(latest.text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    plist = commands.add_parser("plist")
    plist.add_argument("source")
    plist.add_argument("destination")
    plist.add_argument("repo_path")
    plist.add_argument("--release", action="store_true")
    feed = commands.add_parser("appcast")
    feed.add_argument("plist")
    feed.add_argument("archive")
    feed.add_argument("asset_id")
    feed.add_argument("signature")
    feed.add_argument("output")
    links = commands.add_parser("symlinks")
    links.add_argument("root")
    prepare = commands.add_parser("prepare-runtime")
    prepare.add_argument("root")
    latest = commands.add_parser("is-newer")
    latest.add_argument("version")
    latest.add_argument("latest_tag")
    build = commands.add_parser("is-newer-build")
    build.add_argument("version")
    build.add_argument("appcast")
    state = commands.add_parser("release-state")
    state.add_argument("release_json")
    complete = commands.add_parser("complete-draft")
    complete.add_argument("release_json")
    draft_build = commands.add_parser("appcast-build")
    draft_build.add_argument("appcast")
    draft_build.add_argument("version")
    args = parser.parse_args()
    if args.command == "plist":
        with open(Path(args.repo_path) / "package.json") as handle:
            app_version = json.load(handle)["version"]
        write_plist(args.source, args.destination, args.repo_path, args.release, app_version=app_version)
    elif args.command == "appcast":
        with open(args.plist, "rb") as handle:
            info = plistlib.load(handle)
        Path(args.output).write_bytes(appcast(
            info["PilotUpdateRepository"], args.asset_id, info["CFBundleVersion"],
            info["CFBundleShortVersionString"], args.signature, Path(args.archive).stat().st_size,
            info["LSMinimumSystemVersion"],
        ))
    elif args.command == "symlinks":
        validate_symlinks(args.root)
    elif args.command == "prepare-runtime":
        prepare_runtime(args.root)
    elif args.command == "is-newer":
        raise SystemExit(0 if newer_than_latest(args.version, args.latest_tag) else 1)
    elif args.command == "is-newer-build":
        raise SystemExit(0 if newer_build_than_latest(args.version, args.appcast) else 1)
    elif args.command == "appcast-build":
        print(appcast_build(args.appcast, args.version))
    else:
        with open(args.release_json) as handle:
            release = json.load(handle)
        check = {"complete-draft": complete_draft}.get(args.command, release_state)
        print(check(release))


if __name__ == "__main__":
    main()
