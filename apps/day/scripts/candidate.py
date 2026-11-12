#!/usr/bin/env python3
"""Prepare a connected native candidate; assemble/sign only as a separate action.

No install, launch, service registration, update, profile read or provider call.
This is not a release/update distribution. It connects to an existing daemon.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

DESKTOP = Path(__file__).resolve().parents[2] / "desktop/scripts"
sys.path.insert(0, str(DESKTOP))
import bundle_runtime as bundle
import day_build_inputs as day
import gui_release


def configuration(value):
    """Reuse the existing public trust tuple, never generate/replace a key."""
    env = {"PILOT_NEXT_SIGNING_POLICY": "private-adhoc"}
    env.update({"PILOT_NEXT_UPDATER_" + key.upper(): value[key] for key in day.TRUST_FIELDS})
    expected = gui_release.configuration(env)
    if value != expected:
        raise ValueError("Existing updater configuration does not match its native identity")
    return expected


def trust_from(app):
    app = Path(app)
    if not app.is_absolute() or app.is_symlink() or app.name != "Pilot Next.app":
        raise ValueError("Select the existing verified Pilot Next.app explicitly")
    app = app.resolve(strict=True)
    value = bundle.read_json(app / "Contents/Resources/updater-inputs.json")
    config = configuration(value["configuration"])
    # This is read-only verification, not signing, launch or an update proposal.
    bundle.run("/usr/bin/codesign", "--verify", "--deep", "--strict",
               "-R=" + config["code_requirement"], str(app))
    signature = subprocess.check_output(["/usr/bin/codesign", "--display", "--verbose=2", str(app)],
                                        stderr=subprocess.STDOUT, env=bundle.subprocess_env(), text=True, timeout=30)
    if "Signature=adhoc" not in signature.splitlines():
        raise ValueError("Do not downgrade a different signing policy to private ad-hoc")
    bundle.verify(app)
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info.get("CFBundleIdentifier") != config["application_id"] or info.get("CFBundleVersion") != config["build"]:
        raise ValueError("Existing signed app and public configuration differ")
    return config


def temporary_output(path):
    path = Path(path)
    if not path.is_absolute() or path.exists() or path.is_symlink():
        raise ValueError("Use a fresh absolute output")
    parent = path.parent.resolve(strict=True)
    if not parent.is_relative_to(Path(tempfile.gettempdir()).resolve()):
        raise ValueError("Candidate output must stay in a private OS temporary directory")
    metadata = parent.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError("Use a private current-user temporary directory")
    return parent / path.name


def checked_inputs(path):
    path = Path(path).resolve(strict=True)
    value = bundle.read_json(path / "manifest.json")
    source = bundle.source(value["source"])
    config = configuration(value["updater_configuration"])
    if value.get("kind") != "production-rust-inputs" or value.get("profile") != "release":
        raise ValueError("Connected launch requires configured release-profile inputs")
    names = ["pilot-desktop", "pilot-desktop-update-helper", "pilot-visual-worker"]
    bundle.receipt(path, source, names)
    bundle.checked_gui_resources(path / "nsh", path, source)
    methods = bundle.run("/usr/bin/git", "show", source + ":apps/day/native/src/bridge.rs", cwd=bundle.ROOT)
    methods = methods.split("pub const METHODS: &[&str] = &[", 1)[1].split("];", 1)[0]
    names = re.findall(r'"(day\.[A-Za-z.]+)"', methods)
    if (not names or bundle.read_json(path / "nsh/capabilities.json") != day.compiled_capabilities(names)
            or bundle.read_json(path / "nsh/app.json") != {"id": bundle.APP_ID}):
        raise ValueError("Connected resources do not match the exact native method grant")
    env = bundle.subprocess_env()
    for name in ("pilot-desktop", "pilot-desktop-update-helper"):
        actual = day.compiled_receipt(path / name, source, value["recipe_sha256"], value["compiler"],
                                      config, "release", env, bundle.ROOT)
        if actual != value["compiled"][name]:
            raise ValueError("Prepared executable receipt changed")
    package = json.loads(bundle.run("/usr/bin/git", "show", source + ":package.json", cwd=bundle.ROOT))
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", package.get("version", "")):
        raise ValueError("Expected the immutable source's numeric app version")
    return path, value, config, package["version"]


def prepare(source, app, output):
    output = temporary_output(output)
    config = trust_from(app)
    # Same immutable source builder and unmodified released NSH. No .app is
    # assembled here, and no code seal or release/update signature is written.
    day.snapshot_day(source, output, production=config)
    checked_inputs(output)
    return output


def assemble(inputs, output):
    """Explicit local assembly/signing boundary. Never called by prepare."""
    output = temporary_output(output)
    if output.name != "Pilot Next.app":
        raise ValueError("The production bootstrap requires the preserved bundle name")
    inputs, value, config, version = checked_inputs(inputs)
    contents = output / "Contents"
    try:
        (contents / "MacOS").mkdir(parents=True)
        (contents / "Resources").mkdir()
        binary = contents / "MacOS/pilot-desktop"
        shutil.copyfile(inputs / "pilot-desktop", binary)
        binary.chmod(0o755)
        shutil.copytree(inputs / "nsh", contents / "Resources/nsh")
        resources = bundle.read_json(inputs / "gui-resources.json")
        if bundle.inventory(contents / "Resources/nsh") != resources["files"]:
            raise ValueError("Connected resource copy changed")
        bundle.write_json(contents / "Resources/gui-resources.json", resources)
        bundle.write_json(contents / "Resources/connected-candidate.json", {
            "schema": 1, "source": value["source"], "kind": "connected-native-candidate",
            "installable_update": False, "bundled_daemon": False,
            "updater_configuration": config,
        })
        with (contents / "Info.plist").open("wb") as stream:
            plistlib.dump(dict(CFBundleIdentifier=config["application_id"], CFBundleName="Pilot",
                              CFBundleDisplayName="Pilot", CFBundleExecutable="pilot-desktop",
                              CFBundlePackageType="APPL", CFBundleVersion=config["build"],
                              CFBundleShortVersionString=version, LSMinimumSystemVersion="15.0",
                              NSHighResolutionCapable=True), stream)
        # No URL registration, bundled daemon, legacy helper or automatic update
        # target. Connected launch needs only its genuine native executable and
        # NSH resources. Update/release distribution is a separate contract.
        if bundle.native_closure(output) != [binary.resolve()]:
            raise ValueError("Unexpected native executable in connected candidate")
        bundle.run("/usr/bin/codesign", "--force", "--sign", "-", str(output))
        verify(output)
    except BaseException:
        if output.exists():
            shutil.rmtree(output)  # Only this action's fresh temporary candidate.
        raise
    return output


def verify(app):
    app = Path(app).resolve(strict=True)
    contents = app / "Contents"
    value = bundle.read_json(contents / "Resources/connected-candidate.json")
    config = configuration(value["updater_configuration"])
    if (app.name != "Pilot Next.app" or value.get("kind") != "connected-native-candidate"
            or value.get("installable_update") is not False or value.get("bundled_daemon") is not False
            or (contents / "Resources/runtime").exists() or (contents / "Helpers").exists()):
        raise ValueError("Not a connected-only candidate")
    bundle.run("/usr/bin/codesign", "--verify", "--deep", "--strict",
               "-R=" + config["code_requirement"], str(app))
    with (contents / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if (info.get("CFBundleIdentifier") != config["application_id"]
            or info.get("CFBundleVersion") != config["build"]
            or info.get("CFBundleExecutable") != "pilot-desktop"):
        raise ValueError("Candidate native identity mismatch")
    receipt = bundle.read_json(contents / "Resources/gui-resources.json")
    binary = contents / "MacOS/pilot-desktop"
    # codesign changes executable bytes, so the pre-seal receipt binds the
    # source/resource input; the code seal binds final executable + resources.
    if (receipt.get("source") != value["source"] or receipt.get("nsh_release") != bundle.NSH_RELEASE
            or bundle.inventory(contents / "Resources/nsh") != receipt["files"]
            or bundle.native_closure(app) != [binary.resolve()]):
        raise ValueError("Candidate source/resource closure mismatch")
    compiled = json.loads(bundle.run(str(binary), "--build-input-receipt"))
    if (compiled.get("source") != value["source"] or compiled.get("profile") != "release"
            or compiled.get("updater_configuration") != config):
        raise ValueError("Candidate compiled identity mismatch")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    p = commands.add_parser("prepare", help="Build checked inputs only; no assembly/signing")
    p.add_argument("--source", required=True)
    p.add_argument("--trust-from", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p = commands.add_parser("assemble", help="Separately authorized same-identity local assembly and signing")
    p.add_argument("--inputs", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p = commands.add_parser("verify", help="Read-only candidate verification; no launch")
    p.add_argument("app", type=Path)
    args = parser.parse_args()
    if args.action == "prepare":
        output = prepare(args.source, args.trust_from, args.output)
        print("Prepared inputs only. After separate assembly/signing approval:")
        print(shlex.join([sys.executable, str(Path(__file__).resolve()), "assemble", "--inputs", str(output),
                          "--output", str(output.parent / "Pilot Next.app")]))
    elif args.action == "assemble":
        print(assemble(args.inputs, args.output))
    else:
        print(json.dumps(verify(args.app), sort_keys=True))


if __name__ == "__main__":
    main()
