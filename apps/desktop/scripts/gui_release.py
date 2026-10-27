#!/usr/bin/env python3
"""Build release GUI payloads. Never publish, install, launch Local or discover secrets."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import stat
import tempfile
import tomllib
import urllib.request
import zipfile

import bundle_runtime as bundle

MAC_ARCHIVE = "Pilot-Next-macos-arm64.zip"
LINUX_ARCHIVE = "Pilot-Next-linux-x64.zip"


def configuration(env, platform="macos"):
    def required(name):
        value = env.get(name, "")
        if not value:
            raise ValueError(f"Missing release configuration: {name}")
        return value
    # Match the existing private Swift distribution model only after a separate,
    # explicit Rust trust-policy choice. Developer ID/notarization is not inferred.
    if platform == "macos" and required("PILOT_NEXT_SIGNING_POLICY") != "private-adhoc":
        raise ValueError("Rust release requires approved private-adhoc policy; Developer ID/notarization is not configured")
    key = required("PILOT_NEXT_UPDATER_PUBLIC_KEY")
    if len(base64.b64decode(key, validate=True)) != 32:
        raise ValueError("Rust updater public key must contain 32 bytes")
    repo = required("PILOT_NEXT_UPDATER_REPOSITORY")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid Rust updater repository")
    build = required("PILOT_NEXT_UPDATER_BUILD")
    if not re.fullmatch(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,3}", build):
        raise ValueError("Invalid Rust updater build")
    return dict(schema=1, mode="configured", public_key=key, repository=repo,
                application_id=bundle.APP_ID, build=build,
                code_requirement=f'identifier "{bundle.APP_ID}"')


def accepted_capsules(env):
    values = json.loads(env.get("PILOT_NEXT_ACCEPTED_CAPSULES") or "[]")
    if (not isinstance(values, list) or len(values) > 4 or
            any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value) for value in values) or
            len(set(values)) != len(values)):
        raise ValueError("Expected up to four exact qualified retained capsule digests")
    return values


def previous_linux_capsules(repository, token=None, limit=4, opener=urllib.request.urlopen):
    """Runtime capsule ids (SHA256 of the exact linux-gui-package.json) of the newest published Linux releases.

    Admitting them lets an update keep using a daemon that an earlier release started; the
    daemon is never stopped or replaced, and the new app checks its protocol on connect.
    """
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "pilot-release"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = f"https://api.github.com/repos/{repository}/releases?per_page=30"
    with opener(urllib.request.Request(url, headers=headers), timeout=60) as response:
        releases = json.load(response)
    digests = []
    for release in releases:
        asset = next((a for a in release.get("assets", []) if a.get("name") == LINUX_ARCHIVE), None)
        if release.get("draft") or release.get("prerelease") or asset is None:
            continue
        # Public download URL: no credential is sent to the asset CDN.
        request = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "pilot-release"})
        with tempfile.TemporaryFile() as archive:
            with opener(request, timeout=600) as response:
                shutil.copyfileobj(response, archive)
            with zipfile.ZipFile(archive) as package:
                digests.append(hashlib.sha256(package.read("Pilot Next/linux-gui-package.json")).hexdigest())
        if len(digests) == limit:
            break
    return digests


def linux_release_capsules(env, previous=None):
    """Configured capsules first, then the newest previous Linux releases, at most four."""
    if previous is None:
        previous = previous_linux_capsules(env["PILOT_NEXT_UPDATER_REPOSITORY"], env.get("GH_TOKEN"))
    return list(dict.fromkeys(accepted_capsules(env) + list(previous)))[:4]


def macos(expected, output, config):
    if output.exists():
        raise ValueError("Release staging must be fresh")
    output.mkdir(mode=0o700)
    runtime, native, rust = [output / name for name in ("runtime", "native", "rust")]
    bundle.snapshot_build(expected, runtime)
    bundle.snapshot_build(expected, native, native=True)
    bundle.snapshot_rust(expected, rust, production=config)
    app = output / "app/Pilot Next.app"
    app.parent.mkdir()
    bundle.assemble(runtime, rust, native, app, expected, bundle_build=config["build"],
                    accepted_capsules=accepted_capsules(os.environ), production=config)
    # Verify an actual relocated closure, not the input directories.
    moved = output / "relocated GUI/Pilot Next.app"
    moved.parent.mkdir()
    app.rename(moved)
    for directory in (runtime, native, rust):
        shutil.rmtree(directory)  # Only this fresh release's private inputs.
    bundle.verify(moved)
    bundle.native_closure(moved)
    # A leading "=" makes codesign parse the requirement as text rather than a file path.
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R=" + config["code_requirement"], str(moved)], check=True)
    subprocess.run(["/bin/bash", str(bundle.ROOT / "apps/macos/scripts/check-runtime.sh"), str(moved / "Contents/Resources/runtime")], check=True, timeout=300)
    subprocess.run(["/usr/bin/ditto", "-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--keepParent", str(moved), str(output / MAC_ARCHIVE)], check=True, timeout=300)
    artifact(output, expected, "macos", config["build"], MAC_ARCHIVE)


def artifact(output, expected, platform, build, archive):
    path = output / archive
    bundle.write_json(output / "gui-release-artifact.json", dict(schema=1, source=expected,
                      platform=platform, build=build, version=bundle.read_json(bundle.ROOT / "package.json")["version"],
                      archive=archive, bytes=path.stat().st_size, sha256=bundle.digest(path)))


def linux_archive(expected, package, output, build):
    import linux_gui_package as linux
    linux.verify(package)
    metadata = bundle.read_json(package / linux.MANIFEST)
    # Current candidate correctly says false. Do not relabel fixture-only GUI
    # qualification as a usable bundled Local app or verified updater.
    for capability in ("bundled_launch", "installer", "updater"):
        if metadata.get(capability) is not True:
            raise ValueError(f"Linux GUI release blocked: {capability} is not qualified in package policy")
    if metadata.get("native_visual_execution") is not False:
        raise ValueError("Linux native visual execution must remain disabled until confinement qualification")
    if metadata["source"] != expected:
        raise ValueError("Linux GUI release source mismatch")
    if len(base64.b64decode((package / "linux-gui-package.sig").read_text().strip(), validate=True)) != 64:
        raise ValueError("Linux GUI release requires its signed full inventory")
    linux.elf_closure(package)
    output.mkdir(mode=0o700)
    if package.name != "Pilot Next":
        raise ValueError("Linux updater requires the exact Pilot Next package root")
    with zipfile.ZipFile(output / LINUX_ARCHIVE, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for relative in [""] + [item["path"] for item in bundle.inventory(package)]:
            path = package / relative
            mode = path.lstat().st_mode
            name = "Pilot Next" + ("/" + relative if relative else "")
            info = zipfile.ZipInfo(name + ("/" if stat.S_ISDIR(mode) else ""))
            info.create_system = 3
            info.external_attr = mode << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            if stat.S_ISLNK(mode):
                archive.writestr(info, os.readlink(path).encode())
            elif stat.S_ISDIR(mode):
                archive.writestr(info, b"")
            else:
                with archive.open(info, "w", force_zip64=True) as target, path.open("rb") as source:
                    shutil.copyfileobj(source, target)

    artifact(output, expected, "linux", build, LINUX_ARCHIVE)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prerequisites", "macos", "linux-archive"))
    parser.add_argument("--source", required=True)
    parser.add_argument("--platform", choices=("macos", "linux"), default="macos")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--package", type=Path)
    args = parser.parse_args()
    bundle.source(args.source)
    config = configuration(os.environ, args.platform)
    accepted_capsules(os.environ)
    if args.platform == "linux":
        features = tomllib.loads((bundle.ROOT / "apps/desktop/updater/Cargo.toml").read_text())["features"]
        if "native-linux" not in features:
            raise ValueError("Linux GUI release prerequisite missing: native-linux updater implementation and qualification")
    if args.action == "macos":
        macos(args.source, args.output.absolute(), config)
    elif args.action == "linux-archive":
        linux_archive(args.source, args.package.resolve(), args.output.absolute(), config["build"])


if __name__ == "__main__":
    main()
