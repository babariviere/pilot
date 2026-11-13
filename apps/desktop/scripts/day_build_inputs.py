#!/usr/bin/env python3
"""Compile immutable Day package inputs. No signing, packaging, install or launch."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import tomllib

import bundle_runtime as bundle
import day_artifact_host

TARGET = "aarch64-apple-darwin"
CLI_VERSION = "nsh 0.5.0 (f4d68f7)"
CLI_SHA256 = "694ab2f1e4b97871e42399ae55a916f4fb528df8319eb2c0965f9c68331ebdb8"
TRUST_FIELDS = ("public_key", "repository", "application_id", "build", "code_requirement")
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
# crates.io 0.5.0 archive SHA-256s. Each archive's .cargo_vcs_info.json names
# the peeled release commit bundle.NSH_RELEASE["source"].
NSH_CHECKSUMS = {
    "nsh-base": "c7bae08ed29b11f2595cf5b4ce406430b14493d24f07f2f4a9f068188fb35079",
    "nsh-bundler": "b50ea11808a4253e9a821b287b06665b23deee9d2d5da8477bcce2258753817a",
    "nsh-core": "6f93e2fa3cc4e18b393b7935d5551deba8330968f69f2a1b2ff1928cb125782a",
    "nsh-dev": "fc746247e56b895185300d03794e5e0f5b2e8a9cc956f320fe97c5006725aaa6",
    "nsh-engine": "4c0dda64a09a18ae35ba04be534f140d6f3cbcdb30a81b1926dc4718fefaefd2",
    "nsh-i18n": "b4570770dee21d88d2c364e091aa64a53af38480a39d75ee0feec0811a2c0dec",
    "nsh-js": "fda1d0dd5fff1c92ce576cae439317a0d30116a3d260c862eeeccb1dd6a3e713",
    "nsh-macros": "eefb6467662ffb652997c7c252919488aa4723807e3a0f17fff3a8c01c29b22f",
    "nsh-package": "0e292d17debb97b13445c7861dbeb8d39ea424d82426a1b11f60b2703f49b261",
    "nsh-platform-apple": "c21f951bd6b8b53be180f15c9405bd4a952c9ff731d5776a754871e9169de1cf",
    "nsh-platform-macos": "552bfc935c49f1f3fa72f7ad264f5794f65f73c972d943ec28eaa7d824a653ad",
    "nsh-testing": "54ac8c9e9d8205b03748bf3485689b3ea3bd1f8f1b8fbc0b6f66ff19c67d655f",
    "nsh-updater": "8b6df81dce14aadfd08fd2aaf9d6754e922e8537d360bc69dcb28a6e478921bd",
}


def execute(args, *, cwd, env):
    return subprocess.check_output([str(arg) for arg in args], cwd=cwd, env=env,
                                   text=True, timeout=2400)


def tool(path):
    path = Path(path)
    if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("Use an absolute installed executable path")
    return path.resolve(strict=True)


def environment(work, tools, inherited, production):
    """Global MBX defaults; no ambient trust, package hooks or Cargo tuning."""
    env = {name: inherited[name] for name in ("PATH", "HOME", "TMPDIR", "LANG", "SDKROOT", "DEVELOPER_DIR") if name in inherited}
    env.update(NSH_DAY_CLI=str(tools["nsh"]), NSH_DAY_MBX=str(tools["mbx"]),
               NSH_DAY_REAL_CARGO=str(tools["cargo"]), RUSTC=str(tools["rustc"]),
               RUSTDOC=str(tools["rustc"].with_name("rustdoc")),
               RUSTUP_TOOLCHAIN="1.99.1", RUSTUP_AUTO_INSTALL="0",
               CARGO_NET_OFFLINE="true",
               MACOSX_DEPLOYMENT_TARGET="15.0", npm_config_ignore_scripts="true",
               npm_config_manage_package_manager_versions="false",
               COREPACK_ENABLE_NETWORK="0", COREPACK_ENABLE_AUTO_PIN="0")
    # mbx uses a Unix socket below TMPDIR (macOS sun_path is only 104 bytes).
    env["TMPDIR"] = str(work)
    env["DYLD_LIBRARY_PATH"] = str(tools["rustc"].parent.parent / "lib")
    if production is not None:
        import gui_release
        supplied = {"PILOT_NEXT_UPDATER_" + key.upper(): production[key] for key in TRUST_FIELDS}
        supplied["PILOT_NEXT_SIGNING_POLICY"] = "private-adhoc"
        if gui_release.configuration(supplied) != production:
            raise ValueError("Unexpected production updater configuration")
        env.update({key: value for key, value in supplied.items() if key != "PILOT_NEXT_SIGNING_POLICY"})
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
    if not nsh or any(item["version"] != "0.5.0" or item.get("source") != REGISTRY
                      or item.get("checksum") != NSH_CHECKSUMS.get(item["name"]) for item in nsh):
        raise ValueError("Day lock must use only the exact unmodified NSH release")
    if any(item["name"].startswith("gpui") for item in packages):
        raise ValueError("Day input closure must not depend on GPUI")


def visual_lock(seed, resolved):
    def identities(path):
        return {(item["name"], item["version"], item.get("source"), item.get("checksum"))
                for item in tomllib.loads(path.read_text())["package"]}
    original, actual = identities(seed), identities(resolved)
    if (not actual or not actual.issubset(original)
            or any(name.startswith("gpui") for name, *_ in actual)):
        raise ValueError("Isolated visual lock changed pinned source selections or includes GPUI")


def build_artifact(checkout, manifest, name, features, env, profile, log):
    args = [checkout / "apps/day/scripts/cargo", "build", "--manifest-path", manifest,
            "--locked", "--offline", "--bin", name,
            "--message-format=json-render-diagnostics"]
    if features:
        args += ["--features", features]
    if profile == "release":
        args += ["--release"]
    raw = execute(args, cwd=checkout, env=env)
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
    # MBX owns the target/cache location. Consume Cargo's exact executable
    # artifact, not an assumed task-local target or a guessed runner filename.
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


def compiled_capabilities(names):
    # Exact NSH 0.5.0 Capabilities::to_json form. Explicit empty/false defaults
    # are denials, not additional authority. Unknown keys still fail equality.
    return dict(host=names, network=dict(hosts=[], http=[]),
                process=dict(execute=[], exit=False, env=[]), fs=dict(read=[], write=[]),
                statusBar=False, clipboard=False, picker=False, openUrl=False)


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
    for module in (__file__, bundle.__file__, day_artifact_host.__file__):
        path = Path(module).resolve()
        archived = checkout / "apps/desktop/scripts" / path.name
        if not archived.is_file() or path.read_bytes() != archived.read_bytes():
            raise ValueError("Build tools must match the immutable source: " + path.name)


def compile_snapshot(checkout, work, output, expected, tools, inherited, production=None):
    """Only called on a fresh git-archive checkout, never a developer's tree."""
    day = checkout / "apps/day"
    release_lock(day / "native/Cargo.lock")
    env = environment(work, tools, inherited, production)
    compiler = execute([tools["rustc"], "-vV"], cwd=checkout, env=env)
    if not compiler.startswith("rustc 1.99.1 ") or "host: " + TARGET not in compiler:
        raise ValueError("Expected installed native Rust 1.99.1")
    if execute([tools["cargo"], "--version"], cwd=checkout, env=env).split()[1] != "1.99.1":
        raise ValueError("Expected installed Cargo 1.99.1")
    if execute([tools["nsh"], "--version"], cwd=checkout, env=env).strip() != CLI_VERSION:
        raise ValueError("Expected installed unmodified Longbridge NSH 0.5.0")
    if bundle.digest(tools["nsh"]) != CLI_SHA256:
        raise ValueError("Installed NSH release executable checksum mismatch")
    if not re.fullmatch(r"mbx \d+\.\d+\.\d+", execute([tools["mbx"], "--version"], cwd=checkout, env=env).strip()):
        raise ValueError("Expected installed mise-managed mbx")
    recipe = bundle.digest(Path(__file__))
    env.update(PILOT_BUILD_SOURCE=expected, PILOT_BUILD_RECIPE=recipe)
    profile = "release" if production is not None else "debug"
    config = production or dict(schema=1, mode="unconfigured")
    names = host_methods(day)
    original_config = bundle.read_json(day / "nsh.json")
    connected = dict(original_config, id=bundle.APP_ID, capabilities=dict(host=names))
    bundle.write_json(day / "nsh.json", connected)
    # Isolate the existing visual engine, not the GPUI workspace. Preserve its
    # sources, build script, exact dependency versions and seed lock selections.
    visual = checkout / "apps/desktop/visual-worker"
    with (visual / "Cargo.toml").open("a") as stream:
        stream.write("\n[workspace]\n")
    shutil.copyfile(visual.parent / "Cargo.lock", visual / "Cargo.lock")
    # prepare-visual-worker only verifies/extracts the exact archive. Refuse a
    # cache miss here rather than allowing its network download path.
    archive = Path(inherited.get("PILOT_DAY_QUICKJS_ARCHIVE", ""))
    if not archive.is_file():
        raise ValueError("Supply the pinned QuickJS-NG 0.17.0 archive separately")
    downloads = visual.parent / ".tools/downloads"
    downloads.mkdir(parents=True)
    shutil.copyfile(archive, downloads / "quickjs-ng-0.17.0.tar.gz")
    execute([os.sys.executable, visual.parent / "scripts/prepare-visual-worker.py"], cwd=checkout, env=env)
    manifests = [("pilot-desktop", day / "native/Cargo.toml", "macos-host"),
                 ("pilot-artifact-host", day / "native/Cargo.toml", "artifact-host"),
                 ("pilot-desktop-update-helper", checkout / "apps/desktop/updater/Cargo.toml", "native-macos"),
                 ("pilot-visual-worker", visual / "Cargo.toml", "")]
    locked = {path: bundle.digest(path) for path in (day / "native/Cargo.lock", checkout / "apps/desktop/updater/Cargo.lock")}
    inputs = work / "inputs"
    inputs.mkdir()
    # Cargo must prune the former workspace lock for this standalone crate.
    # Resolve offline from its seed, then check every selected source identity
    # against that seed. Builds themselves remain --locked, with no new versions.
    metadata = execute([day / "scripts/cargo", "metadata", "--offline", "--format-version=1",
                        "--manifest-path", visual / "Cargo.toml"], cwd=checkout, env=env)
    (inputs / "visual-metadata.json").write_text(metadata)
    visual_lock(visual.parent / "Cargo.lock", visual / "Cargo.lock")
    binaries, compiled = [], {}
    for name, manifest, features in manifests:
        path = build_artifact(checkout, manifest, name, features, env, profile, inputs / (name + ".cargo.jsonl"))
        if name not in ("pilot-visual-worker", "pilot-artifact-host"):
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
        kind="production-rust-inputs" if production else "development-rust-inputs",
        source=expected, target=TARGET, deployment_target="15.0", profile="release" if production else "dev",
        installable_update=False, updater_configuration=config, binaries=binaries,
        compiler=compiler, recipe_sha256=recipe, compiled=compiled,
        tools={name:dict(path=str(path), sha256=bundle.digest(path)) for name, path in tools.items()},
        connected_configuration=connected,
        visual_manifest_sha256=bundle.digest(visual / "Cargo.toml"),
        visual_lock_sha256=bundle.digest(visual / "Cargo.lock")))
    main = next(item for item in binaries if item["name"] == "pilot-desktop")
    bundle.write_json(inputs / "gui-resources.json", dict(schema=1, kind="nsh-ui-resources", source=expected,
        target=TARGET, nsh_release=bundle.NSH_RELEASE, executable=main, files=bundle.inventory(inputs / "nsh")))
    bundle.receipt(inputs, expected, [name for name, _, _ in manifests])
    day_artifact_host.checked(inputs, expected)
    bundle.checked_gui_resources(inputs / "nsh", inputs, expected)
    inputs.rename(output)


def snapshot_day(expected, output, production=None, *, tools=None, inherited=None):
    bundle.source(expected)
    if os.sys.platform != "darwin" or bundle.run("/usr/bin/uname", "-m") != "arm64":
        raise ValueError("Day input lane supports native macOS arm64 only")
    if output.exists() or output.is_symlink():
        raise ValueError("Day inputs require a fresh output")
    if bundle.run("/usr/bin/git", "cat-file", "-t", expected, cwd=bundle.ROOT) != "commit":
        raise ValueError("Day source must identify an immutable commit")
    inherited = os.environ if inherited is None else inherited
    if tools is None:
        tools = {name:tool(inherited[variable]) for name, variable in
                 (("nsh", "NSH_DAY_CLI"), ("mbx", "NSH_DAY_MBX"),
                  ("cargo", "NSH_DAY_REAL_CARGO"), ("rustc", "RUSTC"))}
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
        compile_snapshot(checkout, work, output, expected, tools, inherited, production)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--production", action="store_true", help="Explicit public trust configuration; still unsigned inputs only")
    args = parser.parse_args()
    config = None
    if args.production:
        import gui_release
        config = gui_release.configuration(os.environ)
    snapshot_day(args.source, args.output.absolute(), config)


if __name__ == "__main__":
    main()
