#!/usr/bin/env python3
"""Qualify unsigned Day inputs. Never assemble, sign, publish, install or launch."""
import argparse
import hashlib
from pathlib import Path
import re
import subprocess

import bundle_runtime as bundle
import day_build_inputs as day

BINARIES = ("pilot-desktop", "pilot-desktop-update-helper", "pilot-visual-worker")


def source_file(source, relative):
    return subprocess.check_output(["git", "show", source + ":" + relative], cwd=bundle.ROOT,
                                   env=bundle.subprocess_env(), timeout=30).decode()


def qualify(source, inputs, *, runtime=None, native=None):
    source = bundle.source(source)
    if (runtime is None) != (native is None):
        raise ValueError("Runtime and native helper inputs must be qualified together")
    inputs = Path(inputs).resolve(strict=True)
    value = bundle.read_json(inputs / "manifest.json")
    config = dict(schema=1, mode="unconfigured")
    if (value.get("schema") != 1 or value.get("source") != source
            or value.get("kind") != "development-rust-inputs" or value.get("profile") != "dev"
            or value.get("installable_update") is not False
            or value.get("updater_configuration") != config
            or value.get("deployment_target") != "15.0"):
        raise ValueError("Qualification requires unsigned, unconfigured Day inputs, not a release")
    if sorted(item.get("name", "") for item in value.get("binaries", [])) != sorted(BINARIES):
        raise ValueError("Expected the exact Day executable/helper/visual-worker inventory")
    bundle.receipt(inputs, source, BINARIES)
    recipe = hashlib.sha256(source_file(source, "apps/desktop/scripts/day_build_inputs.py").encode()).hexdigest()
    if value.get("recipe_sha256") != recipe:
        raise ValueError("Day recipe must match the immutable source, without a tools overlay")
    if (not value.get("compiler", "").startswith("rustc 1.99.1 ")
            or "host: " + day.TARGET not in value["compiler"].splitlines()
            or value.get("tools", {}).get("nsh", {}).get("sha256") != day.CLI_SHA256):
        raise ValueError("Day compiler/official CLI receipt mismatch")
    methods = source_file(source, "apps/day/native/src/bridge.rs")
    section = methods.split("pub const METHODS: &[&str] = &[", 1)[1].split("];", 1)[0]
    names = re.findall(r'"(day\.[A-Za-z.]+)"', section)
    if not names or len(set(names)) != len(names):
        raise ValueError("Expected exact source-matched host methods")
    resources = bundle.checked_gui_resources(inputs / "nsh", inputs, source)
    if (bundle.read_json(inputs / "nsh/capabilities.json") != day.compiled_capabilities(names)
            or bundle.read_json(inputs / "nsh/app.json") != {"id": bundle.APP_ID}):
        raise ValueError("Day resources do not match the immutable native grant/identity")
    # These exact diagnostics exit before AppKit, daemon, provider or update work.
    for name in BINARIES[:2]:
        actual = day.compiled_receipt(inputs / name, source, recipe, value["compiler"],
                                      config, "debug", bundle.subprocess_env(), bundle.ROOT)
        if actual != value.get("compiled", {}).get(name):
            raise ValueError("Day compiled input receipt changed")
    result = dict(schema=1, kind="day-input-qualification", source=source,
                  target=day.TARGET, nsh_release=bundle.NSH_RELEASE,
                  application_id=bundle.APP_ID, installable_update=False,
                  signed_package=False, native_acceptance=False,
                  inputs=bundle.inventory(inputs), resources=resources)
    if runtime is not None:
        runtime, native = Path(runtime).resolve(strict=True), Path(native).resolve(strict=True)
        result["runtime_build"] = bundle.validate_runtime(runtime, source)
        bundle.receipt(native, source, ["PilotPower", "PilotSystemEvents"])
        result["runtime"] = bundle.inventory(runtime)
        result["native"] = bundle.inventory(native)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--inputs", required=True, type=Path)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--native", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists() or args.output.is_symlink():
        raise ValueError("Use a fresh qualification receipt")
    result = qualify(args.source, args.inputs, runtime=args.runtime, native=args.native)
    bundle.write_json(args.output, result)


if __name__ == "__main__":
    main()
