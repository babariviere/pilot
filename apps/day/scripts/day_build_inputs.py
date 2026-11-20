#!/usr/bin/env python3
"""Compile immutable Day package inputs. No signing, packaging, install or launch."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import tomllib

import bundle_runtime as bundle

TARGET = "aarch64-apple-darwin"
NSH_VERSION = bundle.NSH_RELEASE["tag"].removeprefix("v")
ARTIFACT_RUNTIME = f"nsh {NSH_VERSION}"
CLI_VERSION = f"{ARTIFACT_RUNTIME} ({bundle.NSH_RELEASE['source'][:7]})"
CLI_SHA256 = "96066fadf2a578216cf5d2692be56b1db1af7523c2ddeab6e1bf951b352b75d5"
TRUST_FIELDS = ("public_key", "repository", "application_id", "build", "code_requirement")
ARTIFACT_HOST = "pilot-artifact-host"
HOST_MODULE = "packages/artifacts/src/nsh-host.ts"
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
# crates.io 0.6.1 archive SHA-256s. Each archive's .cargo_vcs_info.json names
# the peeled release commit bundle.NSH_RELEASE["source"].
NSH_CHECKSUMS = {
    "nsh-base": "e083cbd14b906efbd94076939c7effd43fa3d1574f1d555919d099e9e0ec3e1c",
    "nsh-bundler": "80ecc1a77d328a278f75365e841324db31805b8da948f54a7ceb5f3840973b15",
    "nsh-core": "4b45a8b194c6879bcb26c6e430b804e49e97ec0fea5fad8c78d7710fd41f74a6",
    "nsh-dev": "5a5a74aadf76568a5ee98a2d96e429e93c99bec736d54172bdc734a68cbe5bd0",
    "nsh-engine": "b4de944c36204b3f778b4fcf90373496d29507e8d38fb5e92a6e29a4cce637d7",
    "nsh-i18n": "f9cfb1cfa50808fc3d66147cfb03f5075269157ff392fbda6104eeb3c3b25ee5",
    "nsh-js": "27702dc84976d755e24f736d0022689429c421549401b7fd3fa5f1a8cd49dc72",
    "nsh-macros": "6f1b3ce01247cac072395d42177725e7972de498eb148d37443196d870cdaf2b",
    "nsh-package": "200354039215917efcfadb5d73605a3a9d611753755da3cf99c40601f0677e3b",
    "nsh-platform-apple": "e3a094eee9e29979fd0fd1bcc8fca568c386d5ab10a46a67c72409c1c257561f",
    "nsh-platform-macos": "8fe81366570211925b77823c8210868d0943976da55944bb327eaa27f215d49e",
    "nsh-testing": "f59bc508ad121ed0d924cfd99cff0061f78c467d5815d54eaec74c9667fb5b4d",
    "nsh-updater": "c263483a4e5c6977dcade98dd1865b0bbdfbf4ff8dafbacaa3ad198e7bf1e2fe",
}


def configuration(env):
    """Day names win by presence, including empty values; legacy is fallback only."""
    def required(suffix):
        canonical, legacy = "PILOT_" + suffix, "PILOT_NEXT_" + suffix
        value = env[canonical] if canonical in env else env.get(legacy, "")
        if not value:
            raise ValueError(f"Missing release configuration: {canonical}")
        return value

    # Do not infer authorization for private ad-hoc signing from updater settings.
    if required("SIGNING_POLICY") != "private-adhoc":
        raise ValueError("Day requires approved private-adhoc policy; Developer ID/notarization is not configured")
    key = required("UPDATER_PUBLIC_KEY")
    if len(base64.b64decode(key, validate=True)) != 32:
        raise ValueError("Rust updater public key must contain 32 bytes")
    repo = required("UPDATER_REPOSITORY")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid Rust updater repository")
    build = required("UPDATER_BUILD")
    if not re.fullmatch(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,3}", build):
        raise ValueError("Invalid Rust updater build")
    return dict(schema=1, mode="configured", public_key=key, repository=repo,
                application_id=bundle.APP_ID, build=build,
                code_requirement=f'identifier "{bundle.APP_ID}"')


def execute(args, *, cwd, env):
    return subprocess.check_output([str(arg) for arg in args], cwd=cwd, env=env,
                                   text=True, timeout=2400)


def tool(path):
    path = Path(path)
    if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("Use an absolute installed executable path")
    # Tool managers can dispatch on the executable name (cargo or rustc).
    return path


def build_tools(env):
    def selected(name, override):
        return tool(env.get(override) or shutil.which(name, path=env.get("PATH", os.defpath)) or "")

    return {"nsh": tool(env["NSH_DAY_CLI"]),
            "cargo": selected("cargo", "NSH_DAY_REAL_CARGO"),
            "rustc": selected("rustc", "RUSTC")}


def environment(work, tools, inherited, production):
    """No ambient trust, package hooks or Cargo tuning."""
    env = {name: inherited[name] for name in ("PATH", "HOME", "TMPDIR", "LANG", "SDKROOT", "DEVELOPER_DIR") if name in inherited}
    env.update(NSH_DAY_CLI=str(tools["nsh"]), TMPDIR=str(work),
               NSH_DAY_REAL_CARGO=str(tools["cargo"]), RUSTC=str(tools["rustc"]),
               RUSTUP_AUTO_INSTALL="0",
               CARGO_NET_OFFLINE="true",
               MACOSX_DEPLOYMENT_TARGET="15.0", npm_config_ignore_scripts="true",
               npm_config_manage_package_manager_versions="false",
               COREPACK_ENABLE_NETWORK="0", COREPACK_ENABLE_AUTO_PIN="0")
    if production is not None:
        supplied = {"PILOT_UPDATER_" + key.upper(): production[key] for key in TRUST_FIELDS}
        supplied["PILOT_SIGNING_POLICY"] = "private-adhoc"
        if configuration(supplied) != production:
            raise ValueError("Unexpected production updater configuration")
        # The shared updater crate still uses its legacy compile-time names.
        # Translate only this validated tuple, never ambient aliases or secrets.
        env.update({"PILOT_NEXT_UPDATER_" + key.upper(): production[key] for key in TRUST_FIELDS})
    return env


def host_methods(day):
    source = (day / "native/src/bridge.rs").read_text()
    section = source.split("pub const METHODS: &[&str] = &[", 1)[1].split("];", 1)[0]
    names = re.findall(r'"(day\.[A-Za-z.]+)"', section)
    if not names or len(set(names)) != len(names) or "*" in section:
        raise ValueError("Expected exact native host methods")
    return names


def release_lock(path):
    packages = tomllib.loads(path.read_text())["package"]
    nsh = [item for item in packages if item["name"].startswith("nsh-")]
    if not nsh or any(item["version"] != NSH_VERSION or item.get("source") != REGISTRY
                      or item["name"] not in NSH_CHECKSUMS
                      or item.get("checksum") != NSH_CHECKSUMS[item["name"]] for item in nsh):
        raise ValueError("Day lock must use only the exact unmodified NSH release")
    if any(item["name"].startswith("gpui") for item in packages):
        raise ValueError("Day input closure must not depend on GPUI")


def build_artifact(checkout, manifest, name, features, env, profile, log):
    args = [checkout / "apps/day/scripts/cargo", "build", "--manifest-path", manifest,
            "--locked", "--offline", "--bin", name,
            "--message-format=json-render-diagnostics"]
    if features:
        args += ["--features", features]
    if profile == "release":
        args += ["--release"]
    raw = execute(args, cwd=checkout / "apps/day", env=env)
    log.write_text(raw)
    paths = []
    for line in raw.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (item.get("reason") == "compiler-artifact" and item["target"]["name"] == name
                and item.get("executable")):
            paths.append(Path(item["executable"]))
    if len(paths) != 1:
        raise ValueError("Expected one genuine Cargo executable artifact: " + name)
    path = paths[0].resolve(strict=True)
    # Consume Cargo's exact executable artifact, not an assumed target path.
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("Cargo artifact must be an executable file")
    if execute(["/usr/bin/lipo", "-archs", path], cwd=checkout, env=env).strip() != "arm64":
        raise ValueError("Day input architecture mismatch")
    return path


def compiled_receipt(binary, expected, recipe, compiler, config, profile, env, cwd):
    raw = execute([binary, "--build-input-receipt"], cwd=cwd, env=env)
    value = json.loads(raw)
    wanted = dict(schema=1, kind="compiled-build-input", source=expected, recipe=recipe,
                  target=TARGET, profile=profile, compiler=compiler.strip().replace("\n", "|"),
                  updater_configuration=config)
    if value != wanted:
        raise ValueError("Compiled source/compiler/config receipt mismatch: " + binary.name)
    return value


def artifact_identity(binary, source, recipe, *, module=None):
    """Reuse the Node transport's bounded protocol and joined exit, never a second supervisor."""
    if module is None:
        module = bundle.ROOT / HOST_MODULE
        archived = subprocess.check_output(["/usr/bin/git", "show", source + ":" + HOST_MODULE],
            cwd=bundle.ROOT, env=bundle.subprocess_env(), timeout=30)
        if module.read_bytes() != archived:
            raise ValueError("Artifact transport must match the immutable source")
    node = tool(shutil.which("node") or "")
    # Fixed trusted program, not artifact source. callArtifactHost owns empty env,
    # its deadline, 8KiB output ceiling, identity validation and child join.
    program = """
try {
 const [module, binary, runtime, source, recipe] = process.argv.slice(1);
 const {callArtifactHost} = await import(module);
 const identity = {schema:1,kind:'nsh-source-host',runtime,source,recipe};
 const text = 'export default function Artifact() { return null; }';
 const value = await callArtifactHost({action:'compile',entry:'Artifact.tsx',source:text},
  undefined,binary,identity,8192);
 if(value !== null) throw Error();
} catch { process.exitCode = 1; }
"""
    try:
        execute([node, "--input-type=module", "-e", program, Path(module).resolve().as_uri(),
                 binary, ARTIFACT_RUNTIME, source, recipe],
                cwd=Path(binary).parent, env={})
    except subprocess.CalledProcessError as error:
        raise ValueError("Artifact helper compiled source identity mismatch") from error
    return dict(schema=1, kind="nsh-source-host", runtime=ARTIFACT_RUNTIME, source=source, recipe=recipe)


def artifact_host(inputs, source, *, module=None):
    """Exact input evidence reused by the Day builder, qualifier and explicit Day assembly."""
    inputs = Path(inputs)
    value = bundle.read_json(inputs / "manifest.json")
    bundle.receipt(inputs, source, [ARTIFACT_HOST])
    recipe = value.get("recipe_sha256", "")
    if (value.get("source") != bundle.source(source) or not isinstance(recipe, str)
            or not re.fullmatch(r"[0-9a-f]{64}", recipe)):
        raise ValueError("Artifact helper input source/recipe mismatch")
    path = inputs / ARTIFACT_HOST
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o6022
            or not info.st_mode & 0o111 or info.st_uid not in (0, os.geteuid())):
        raise ValueError("Unsafe artifact helper input")
    with path.open("rb") as stream:
        if stream.read(4) != b"\xcf\xfa\xed\xfe":
            raise ValueError("Artifact helper must be native Mach-O")
    entry = next(item for item in value["binaries"] if item["name"] == ARTIFACT_HOST)
    identity = artifact_identity(path, source, recipe, module=module)
    return dict(schema=1, identity=identity, bytes=entry["bytes"], sha256=entry["sha256"])


INSPECTION_WINDOW = dict(kinds=["normal"], levels=["normal"], max=1)


def compiled_capabilities(names):
    # Exact NSH 0.6.1 Capabilities::to_json form. It omits ungranted optional
    # capabilities. Explicit empty/false defaults are denials. Unknown keys fail equality.
    return dict(host=names, network=dict(hosts=[], http=[]),
                process=dict(execute=[], exit=False, env=[]), fs=dict(read=[], write=[]),
                statusBar=False, clipboard=True, picker=True, openUrl=False, windows=INSPECTION_WINDOW)


def resource_closure(built, output, names):
    files = bundle.inventory(built)
    allowed = {"bundle.nshc", "bundle.js", "bundle.js.map", "capabilities.json", "app.json", "assets"}
    if any(item["path"].split("/", 1)[0] not in allowed or item["kind"] == "link" for item in files):
        raise ValueError("Unexpected NSH resource or dynamic chunk")
    if not {"bundle.nshc", "capabilities.json", "app.json"}.issubset(
            {item["path"] for item in files if item["kind"] == "file" and item["bytes"] > 0}):
        raise ValueError("NSH resource closure is incomplete")
    if bundle.read_json(built / "capabilities.json") != compiled_capabilities(names):
        raise ValueError("NSH resource capabilities must match exact native grant")
    if bundle.read_json(built / "app.json") != {"id": bundle.APP_ID}:
        raise ValueError("NSH resource application identity mismatch")
    shutil.copytree(built, output)
    if bundle.inventory(output) != files:
        raise ValueError("NSH resource copy changed")


def source_tools(checkout):
    # These modules run outside the archive. Refuse a current-helper overlay
    # on older app source, including edits not yet in the supplied commit.
    for module in (__file__, bundle.__file__):
        path = Path(module).resolve()
        archived = checkout / "apps/day/scripts" / path.name
        if not archived.is_file() or path.read_bytes() != archived.read_bytes():
            raise ValueError("Build tools must match the immutable source: " + path.name)


def compile_snapshot(checkout, work, output, expected, tools, inherited, production=None, *, connected_only=False):
    """Only called on a fresh git-archive checkout, never a developer's tree."""
    if connected_only and production is None:
        raise ValueError("Connected candidate requires configured release inputs")
    day = checkout / "apps/day"
    release_lock(day / "native/Cargo.lock")
    env = environment(work, tools, inherited, production)
    compiler = execute([tools["rustc"], "-vV"], cwd=day, env=env)
    if "host: " + TARGET not in compiler.splitlines():
        raise ValueError("Expected an installed native arm64 macOS Rust compiler")
    if bundle.digest(tools["nsh"]) != CLI_SHA256:
        raise ValueError("Installed NSH release executable checksum mismatch")
    if execute([tools["nsh"], "--version"], cwd=checkout, env=env).strip() != CLI_VERSION:
        raise ValueError(f"Expected installed unmodified Longbridge NSH {NSH_VERSION}")
    recipe = bundle.digest(Path(__file__))
    env.update(PILOT_BUILD_SOURCE=expected, PILOT_BUILD_RECIPE=recipe)
    profile = "release" if production is not None else "debug"
    config = production or dict(schema=1, mode="unconfigured")
    names = host_methods(day)
    original_config = bundle.read_json(day / "nsh.json")
    connected = dict(original_config, id=bundle.APP_ID,
                     capabilities=dict(host=names, clipboard=True, picker=True, windows=INSPECTION_WINDOW))
    bundle.write_json(day / "nsh.json", connected)
    manifests = [("pilot-desktop", day / "native/Cargo.toml", "macos-host")]
    locked = {day / "native/Cargo.lock": bundle.digest(day / "native/Cargo.lock")}
    inputs = work / "inputs"
    inputs.mkdir()
    if not connected_only:
        # The app-only candidate does not build the updater or NSH artifact host.
        manifests += [(ARTIFACT_HOST, day / "native/Cargo.toml", "artifact-host"),
                      ("pilot-desktop-update-helper", checkout / "crates/updater/Cargo.toml", "native-macos,day-app")]
        updater_lock = checkout / "crates/updater/Cargo.lock"
        locked[updater_lock] = bundle.digest(updater_lock)
    binaries, compiled = [], {}
    for name, manifest, features in manifests:
        path = build_artifact(checkout, manifest, name, features, env, profile, inputs / (name + ".cargo.jsonl"))
        if name != ARTIFACT_HOST:
            compiled[name] = compiled_receipt(path, expected, recipe, compiler, config, profile, env, checkout)
        shutil.copyfile(path, inputs / name)
        (inputs / name).chmod(0o755)
        binaries.append(dict(name=name, bytes=path.stat().st_size, sha256=bundle.digest(path)))
    if any(bundle.digest(path) != digest for path, digest in locked.items()):
        raise ValueError("Source lock changed during build")
    # Installed CLI bundles the connected entry. It never packages/signs a stock
    # runner. Wrapper seeds the genuine released runner lock and guards hooks.
    built = work / "bundled"
    execute([day / "nsh.sh", "build", "Connected.tsx", "--release", "-o", built], cwd=day, env=env)
    if any(bundle.digest(path) != digest for path, digest in locked.items()):
        raise ValueError("Source lock changed during resource build")
    resource_closure(built, inputs / "nsh", names)
    bundle.write_json(inputs / "manifest.json", dict(schema=1,
        kind="connected-candidate-inputs" if connected_only else "production-rust-inputs" if production else "development-rust-inputs",
        source=expected, target=TARGET, deployment_target="15.0", profile="release" if production else "dev",
        installable_update=False, updater_configuration=config, binaries=binaries,
        compiler=compiler, recipe_sha256=recipe, compiled=compiled,
        tools={name:dict(path=str(path), sha256=bundle.digest(path)) for name, path in tools.items()},
        connected_configuration=connected))
    main = next(item for item in binaries if item["name"] == "pilot-desktop")
    bundle.write_json(inputs / "gui-resources.json", dict(schema=1, kind="nsh-ui-resources", source=expected,
        target=TARGET, nsh_release=bundle.NSH_RELEASE, executable=main, files=bundle.inventory(inputs / "nsh")))
    bundle.receipt(inputs, expected, [name for name, _, _ in manifests])
    if not connected_only:
        artifact_host(inputs, expected, module=checkout / HOST_MODULE)
    bundle.checked_gui_resources(inputs / "nsh", inputs, expected)
    inputs.rename(output)


def snapshot_day(expected, output, production=None, *, tools=None, inherited=None, connected_only=False):
    bundle.source(expected)
    if os.sys.platform != "darwin" or bundle.run("/usr/bin/uname", "-m") != "arm64":
        raise ValueError("Day input lane supports native macOS arm64 only")
    if output.exists() or output.is_symlink():
        raise ValueError("Day inputs require a fresh output")
    if bundle.run("/usr/bin/git", "cat-file", "-t", expected, cwd=bundle.ROOT) != "commit":
        raise ValueError("Day source must identify an immutable commit")
    inherited = os.environ if inherited is None else inherited
    if tools is None:
        tools = build_tools(inherited)
    with tempfile.TemporaryDirectory(prefix="day-build-", dir="/tmp") as directory:
        work = Path(directory).resolve()
        checkout = work / "source"
        checkout.mkdir()
        archive = work / "source.tar"
        with archive.open("wb") as stream:
            subprocess.run(["/usr/bin/git", "archive", "--format=tar", expected], cwd=bundle.ROOT,
                           stdout=stream, env=bundle.subprocess_env(), check=True, timeout=60)
        with tarfile.open(archive) as stream:
            stream.extractall(checkout, filter="data")
        source_tools(checkout)
        compile_snapshot(checkout, work, output, expected, tools, inherited, production, connected_only=connected_only)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--production", action="store_true", help="Explicit public trust configuration; still unsigned inputs only")
    args = parser.parse_args()
    config = None
    if args.production:
        config = configuration(os.environ)
    snapshot_day(args.source, args.output.absolute(), config)


if __name__ == "__main__":
    main()
