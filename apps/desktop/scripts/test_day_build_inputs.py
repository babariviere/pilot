"""Private offline recipe fixtures. Fake compilers/resources are NOT native acceptance."""
import json
import base64
import os
import shlex
import sys
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bundle_runtime as bundle
import day_build_inputs as day


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.env = dict(PILOT_SIGNING_POLICY="private-adhoc",
                        PILOT_UPDATER_PUBLIC_KEY=base64.b64encode(bytes([42]) * 32).decode(),
                        PILOT_UPDATER_REPOSITORY="Owner/Repo.Name", PILOT_UPDATER_BUILD="100.1")
        self.legacy = {key.replace("PILOT_", "PILOT_NEXT_", 1): value for key, value in self.env.items()}

    def test_canonical_legacy_and_mixed_inputs_preserve_exact_values(self):
        import gui_release
        expected = gui_release.configuration(self.legacy)
        self.assertEqual(day.configuration(self.env), expected)
        self.assertEqual(day.configuration(self.legacy), expected)
        mixed = self.legacy | {"PILOT_UPDATER_BUILD": "100.2"}
        self.assertEqual(day.configuration(mixed), expected | {"build": "100.2"})
        self.assertEqual(expected["repository"], self.env["PILOT_UPDATER_REPOSITORY"])
        self.assertEqual(expected["public_key"], self.env["PILOT_UPDATER_PUBLIC_KEY"])

    def test_canonical_presence_wins_even_when_empty_or_invalid(self):
        conflicting = {name: "invalid" for name in self.legacy}
        self.assertEqual(day.configuration(conflicting | self.env), day.configuration(self.env))
        for name in self.env:
            for value in ("", "invalid", self.env[name] + "\n"):
                with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                    day.configuration(self.legacy | self.env | {name: value})
        with self.assertRaisesRegex(ValueError, "PILOT_SIGNING_POLICY"):
            day.configuration({})

    def test_validated_tuple_only_reaches_shared_native_consumer(self):
        config = day.configuration(self.env)
        tools = {key: Path("/qualified") / key for key in ("nsh", "cargo", "rustc", "mbx")}
        inherited = self.env | self.legacy | {"PILOT_UPDATER_PRIVATE_KEY": "not-forwarded"}
        env = day.environment(Path("/private/work"), tools, inherited, config)
        for field in day.TRUST_FIELDS:
            self.assertEqual(env["PILOT_NEXT_UPDATER_" + field.upper()], config[field])
        self.assertFalse(any(key.startswith("PILOT_") and not key.startswith("PILOT_NEXT_UPDATER_") for key in env))
        for field in day.TRUST_FIELDS:
            with self.subTest(field=field), self.assertRaises(ValueError):
                day.environment(Path("/private/work"), tools, {}, config | {field: "different"})

    def test_day_production_cli_uses_alias_parser(self):
        argv = ["day_build_inputs.py", "--production", "--source", "a" * 40, "--output", "/unused"]
        for env in (self.env, self.legacy):
            with patch.dict(os.environ, env, clear=True), patch.object(sys, "argv", argv), \
                    patch.object(day, "snapshot_day") as build:
                day.main()
                self.assertEqual(build.call_args.args[2], day.configuration(self.env))

    def test_bundle_cli_selects_day_adapter_without_changing_gpui(self):
        argv = ["bundle_runtime.py", "bundle", "--production", "--source", "a" * 40,
                "--runtime", "/runtime", "--executables", "/executables", "--native", "/native",
                "--output", "/output"]
        for env in (self.env, self.legacy):
            with patch.dict(os.environ, env, clear=True), \
                    patch.object(sys, "argv", argv + ["--gui-resources", "/nsh"]), \
                    patch.object(bundle, "assemble") as assemble:
                bundle.main()
                self.assertEqual(assemble.call_args.kwargs["production"], day.configuration(self.env))
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, "argv", argv), \
                patch.object(bundle, "assemble") as assemble, self.assertRaises(ValueError):
            bundle.main()
        assemble.assert_not_called()
        with patch.dict(os.environ, self.legacy, clear=True), patch.object(sys, "argv", argv), \
                patch.object(bundle, "assemble") as assemble:
            bundle.main()
            self.assertEqual(assemble.call_args.kwargs["production"], day.configuration(self.env))


class RecipeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="day-input-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = "a" * 40
        (self.root / "bin").mkdir()
        self.tools = {name:self.root / "bin" / name for name in ("nsh", "mbx", "cargo", "rustc")}
        for path in self.tools.values():
            path.write_text("#!/bin/sh\nexit 1\n")
            path.chmod(0o755)
        self.compiler = "rustc 1.99.1 (private fixture)\nhost: " + day.TARGET + "\n"

    def resources(self):
        built = self.root / "built"
        built.mkdir()
        (built / "bundle.nshc").write_bytes(b"synthetic fixture, never executed")
        bundle.write_json(built / "capabilities.json", day.compiled_capabilities(["day.today.read"]))
        bundle.write_json(built / "app.json", {"id":bundle.APP_ID})
        return built

    def test_environment_uses_global_mbx_defaults_and_drops_ambient_authority(self):
        inherited = dict(PATH="/usr/bin:/bin", HOME=str(self.root / "user"), PILOT_NEXT_UPDATER_PUBLIC_KEY="fixture",
                         GH_TOKEN="never-forward", NODE_OPTIONS="--import hostile", RUSTFLAGS="bad",
                         MBX_SOCKET="bad", RUSTC_WRAPPER="bad", NSH_APP_DIR="bad",
                         npm_config_ignore_scripts="false", CARGO_TARGET_DIR="bad", CARGO_HOME="bad",
                         CARGO_BUILD_JOBS="bad", CARGO_PROFILE_DEV_DEBUG="bad")
        env = day.environment(self.root, self.tools, inherited, None)
        for key in inherited.keys() - {"PATH", "HOME", "npm_config_ignore_scripts"}:
            self.assertNotIn(key, env)
        self.assertEqual(env["HOME"], inherited["HOME"])
        self.assertNotIn("CARGO_HOME", env)
        self.assertNotIn("CARGO_TARGET_DIR", env)
        self.assertNotIn("CARGO_INCREMENTAL", env)
        self.assertFalse(any(key.startswith("MBX_") for key in env))
        self.assertEqual(env["CARGO_NET_OFFLINE"], "true")
        self.assertNotIn("CARGO_BUILD_JOBS", env)
        self.assertFalse(any(key.startswith("CARGO_PROFILE_") for key in env))
        self.assertEqual(env["npm_config_ignore_scripts"], "true")
        self.assertEqual(env["RUSTUP_AUTO_INSTALL"], "0")

    def test_missing_production_configuration_refuses_not_fixture_fallback(self):
        with self.assertRaisesRegex(ValueError, "Missing release configuration"):
            day.configuration({})
        with self.assertRaises(KeyError):
            day.environment(self.root, self.tools, {}, {})

    def test_direct_cargo_is_explicit_and_excludes_mbx(self):
        tools = {key: value for key, value in self.tools.items() if key != "mbx"}
        env = day.environment(self.root, tools, {"NSH_DAY_CARGO_MODE": "direct"}, None)
        self.assertEqual(env["NSH_DAY_CARGO_MODE"], "direct")
        self.assertNotIn("NSH_DAY_MBX", env)
        with self.assertRaisesRegex(ValueError, "Invalid Cargo mode"):
            day.environment(self.root, tools, {"NSH_DAY_CARGO_MODE": "direct"}, {})
        cargo = tools["cargo"]
        cargo.write_text('#!/bin/sh\nprintf "direct:%s\\n" "$*"\n')
        result = subprocess.run([str(bundle.ROOT / "apps/day/scripts/cargo"), "metadata", "--offline"],
                                env={"PATH": "/usr/bin:/bin", "NSH_DAY_CARGO_MODE": "direct",
                                     "NSH_DAY_REAL_CARGO": str(cargo), "NSH_DAY_MBX": "/nonexistent"},
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, "direct:metadata --offline\n")

    def test_cargo_defaults_to_mbx(self):
        mbx = self.tools["mbx"]
        mbx.write_text('#!/bin/sh\nif [ "$1" = --version ]; then echo "mbx 1.30.0"; '
                       'else printf "mbx:%s:%s\\n" "$MBX_CARGO_SHIM_MODE" "$*"; fi\n')
        result = subprocess.run([str(bundle.ROOT / "apps/day/scripts/cargo"), "metadata"],
                                env={"PATH": "/usr/bin:/bin", "NSH_DAY_REAL_CARGO": str(self.tools["cargo"]),
                                     "NSH_DAY_MBX": str(mbx)}, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, "mbx:1:metadata\n")

    def test_selected_xcode_survives_the_isolated_build_environment(self):
        selected = "/Applications/Xcode_26.2.app/Contents/Developer"
        env = day.environment(self.root, self.tools, {"DEVELOPER_DIR": selected}, None)
        self.assertEqual(env["DEVELOPER_DIR"], selected)

    def test_executing_tools_must_match_the_archived_source(self):
        directory = self.root / "apps/desktop/scripts"
        directory.mkdir(parents=True)
        for module in (day.__file__, bundle.__file__):
            shutil.copyfile(module, directory / Path(module).name)
        day.source_tools(self.root)
        for module in (day.__file__, bundle.__file__):
            path = directory / Path(module).name
            original = path.read_bytes()
            path.write_bytes(original + b"\n# different source\n")
            with self.assertRaisesRegex(ValueError, "match the immutable source"):
                day.source_tools(self.root)
            path.write_bytes(original)
        (directory / "day_build_inputs.py").unlink()
        with self.assertRaisesRegex(ValueError, "match the immutable source"):
            day.source_tools(self.root)

    def test_tools_require_absolute_executable_files(self):
        with self.assertRaises(ValueError):
            day.tool("cargo")
        path = self.root / "noexec"
        path.write_text("no")
        with self.assertRaises(ValueError):
            day.tool(path)
        self.assertEqual(day.tool(self.tools["nsh"]), self.tools["nsh"])

    def test_current_source_lock_and_exact_bridge_names(self):
        app = bundle.ROOT / "apps/day"
        day.release_lock(app / "native/Cargo.lock")
        names = day.host_methods(app)
        self.assertIn("day.flush.ack", names)
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all("*" not in name for name in names))

    def test_wrong_nsh_release_or_gpui_in_native_closure_refuses(self):
        lock = self.root / "Cargo.lock"
        lock.write_text('[[package]]\nname="nsh-core"\nversion="0.4.0"\nsource="floating-main"\n')
        with self.assertRaisesRegex(ValueError, "exact unmodified"):
            day.release_lock(lock)
        text = (bundle.ROOT / "apps/day/native/Cargo.lock").read_text()
        checksum = day.NSH_CHECKSUMS["nsh-core"]
        lock.write_text(text.replace(checksum, "0" * 64))
        with self.assertRaisesRegex(ValueError, "exact unmodified"):
            day.release_lock(lock)
        git = "git+https://github.com/longbridge/nsh?rev=" + bundle.NSH_RELEASE["source"]
        lock.write_text(f'[[package]]\nname="nsh-core"\nversion="0.4.0"\nsource="{git}"\n')
        with self.assertRaisesRegex(ValueError, "exact unmodified"):
            day.release_lock(lock)
        lock.write_text(text + '\n[[package]]\nname="gpui"\nversion="1.0.0"\n')
        with self.assertRaisesRegex(ValueError, "GPUI"):
            day.release_lock(lock)

    def test_isolated_visual_lock_keeps_seed_source_identities(self):
        seed, resolved = self.root / "seed.lock", self.root / "isolated.lock"
        entry = '[[package]]\nname="libc"\nversion="0.2.191"\nsource="registry+crates"\nchecksum="exact"\n'
        seed.write_text(entry + '\n[[package]]\nname="gpui-pre"\nversion="0.3.11"\n')
        resolved.write_text(entry)
        day.visual_lock(seed, resolved)
        for bad in (entry.replace('"exact"', '"other"'), entry.replace('0.2.191', '0.2.192'), seed.read_text()):
            resolved.write_text(bad)
            with self.assertRaisesRegex(ValueError, "pinned source"):
                day.visual_lock(seed, resolved)
    def test_resource_closure_is_exact_relocatable_and_detects_tamper(self):
        built = self.resources()
        (built / "assets").mkdir()
        (built / "assets/icon.png").write_bytes(b"image fixture")
        closure = self.root / "nsh"
        day.resource_closure(built, closure, ["day.today.read"])
        executable = self.root / "pilot-desktop"
        executable.write_bytes(b"fake executable")
        value = dict(schema=1, kind="nsh-ui-resources", source=self.source, target=day.TARGET,
                     nsh_release=bundle.NSH_RELEASE, executable=dict(name=executable.name,
                     bytes=executable.stat().st_size, sha256=bundle.digest(executable)),
                     files=bundle.inventory(closure))
        bundle.write_json(self.root / "gui-resources.json", value)
        bundle.checked_gui_resources(closure, self.root, self.source)
        (closure / "bundle.nshc").write_bytes(b"other fixture")
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            bundle.checked_gui_resources(closure, self.root, self.source)

    def test_missing_resource_dynamic_chunks_links_and_capability_widening_refuse(self):
        built = self.resources()
        for name in ("chunk.nshc", "extra"):
            with self.subTest(name=name):
                (built / name).write_bytes(b"bad")
                with self.assertRaisesRegex(ValueError, "Unexpected"):
                    day.resource_closure(built, self.root / "nsh", ["day.today.read"])
                (built / name).unlink()
        (built / "assets").symlink_to(".")
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            day.resource_closure(built, self.root / "nsh", ["day.today.read"])
        (built / "assets").unlink()
        bundle.write_json(built / "capabilities.json", {"host":["day.*"]})
        with self.assertRaisesRegex(ValueError, "capabilities"):
            day.resource_closure(built, self.root / "nsh", ["day.today.read"])
        (built / "bundle.nshc").unlink()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            day.resource_closure(built, self.root / "nsh", ["day.today.read"])

    def test_receipt_requires_actual_compiled_source_compiler_target_config(self):
        config = dict(schema=1, mode="unconfigured")
        good = dict(schema=1, kind="compiled-build-input", source=self.source, recipe="b" * 64,
                    target=day.TARGET, profile="debug", compiler=self.compiler.strip().replace("\n", "|"),
                    updater_configuration=config)
        for name in ("pilot-desktop", "pilot-desktop-update-helper"):
            binary = self.root / name
            with patch.object(day, "execute", return_value=json.dumps(good)) as execute:
                self.assertEqual(day.compiled_receipt(binary, self.source, "b" * 64, self.compiler,
                                 config, "debug", {}, self.root), good)
                self.assertEqual(execute.call_args.args[0], [binary, "--build-input-receipt"])
            for field in ("source", "recipe", "target", "profile", "compiler", "updater_configuration"):
                bad = dict(good, **{field:"wrong"})
                with self.subTest(name=name, field=field), patch.object(day, "execute", return_value=json.dumps(bad)):
                    with self.assertRaisesRegex(ValueError, "Compiled"):
                        day.compiled_receipt(binary, self.source, "b" * 64, self.compiler, config, "debug", {}, self.root)

    def test_normalized_release_denials_do_not_admit_extra_capabilities(self):
        built = self.resources()
        original = bundle.read_json(built / "capabilities.json")
        self.assertEqual(original["fs"], {"read":[], "write":[]})
        self.assertEqual(original["network"], {"hosts":[], "http":[]})
        self.assertTrue(original["clipboard"])
        self.assertTrue(original["picker"])
        for changes in ({"clipboard":False}, {"picker":False}, {"openUrl":True}, {"extra":False}, {"process":{"execute":["sh"], "env":[], "exit":False}},
                        {"fs":{"read":["/"], "write":[]}}):
            bundle.write_json(built / "capabilities.json", original | changes)
            with self.assertRaisesRegex(ValueError, "capabilities"):
                day.resource_closure(built, self.root / "nsh", ["day.today.read"])

    def test_build_uses_real_cargo_artifact_not_runner_name_guessing(self):
        target = self.root / "target"
        target.mkdir()
        binary = target / "pilot-desktop"
        binary.write_bytes(b"faux")
        binary.chmod(0o755)
        raw = json.dumps(dict(reason="compiler-artifact", target=dict(name="pilot-desktop"), executable=str(binary)))
        env = {}
        with patch.object(day, "execute", side_effect=[raw, "arm64"]) as execute:
            actual = day.build_artifact(self.root, self.root / "native/Cargo.toml", "pilot-desktop", "macos-host",
                                        env, "debug", self.root / "cargo.jsonl")
            args = [str(arg) for arg in execute.call_args_list[0].args[0]]
            self.assertEqual(actual, binary)
            self.assertIn("--locked", args)
            self.assertIn("--offline", args)
            self.assertIn("macos-host", args)
            self.assertNotIn("gpui", " ".join(args))
        for raw in ("", raw + "\n" + raw, json.dumps(dict(reason="compiler-artifact", target=dict(name="stock-runner"), executable=str(binary)))):
            with patch.object(day, "execute", return_value=raw):
                with self.assertRaisesRegex(ValueError, "one genuine"):
                    day.build_artifact(self.root, self.root / "native/Cargo.toml", "pilot-desktop", "macos-host",
                                       env, "debug", self.root / "cargo.jsonl")

    def test_existing_assembler_keeps_visual_worker_and_helper_equality(self):
        # The selector cannot substitute a renamed stock runner or bypass the
        # existing bundle admission contract. Existing assembler tests cover
        # actual missing-worker and differing compiled configuration refusal.
        with patch.object(day, "snapshot_day") as build:
            bundle.snapshot_rust(self.source, self.root / "inputs", gui="day")
            build.assert_called_once_with(self.source, self.root / "inputs", None)
        with self.assertRaisesRegex(ValueError, "Unknown"):
            bundle.snapshot_rust(self.source, self.root / "inputs", gui="stock-runner")

    def test_platform_and_immutable_source_are_fail_closed_before_build(self):
        with patch.object(day.os.sys, "platform", "linux"):
            with self.assertRaisesRegex(ValueError, "native macOS arm64"):
                day.snapshot_day(self.source, self.root / "output")
        with self.assertRaisesRegex(ValueError, "immutable"):
            day.snapshot_day("main", self.root / "output")

    def test_complete_recipe_emits_bound_inputs_and_keeps_missing_trust_unavailable(self):
        self.compile_recipe(connected_only=False)

    def test_connected_candidate_builds_only_main_and_resources_without_quickjs_or_helpers(self):
        self.compile_recipe(connected_only=True)

    def test_configured_full_distribution_still_builds_all_helpers(self):
        self.compile_recipe(connected_only=False, configured=True)

    def test_connected_candidate_refuses_unconfigured_inputs_before_build(self):
        with patch.object(day, "execute", side_effect=AssertionError("must not build")):
            with self.assertRaisesRegex(ValueError, "configured release inputs"):
                day.compile_snapshot(self.root, self.root, self.root / "out", self.source,
                                     self.tools, {}, connected_only=True)

    def compile_recipe(self, *, connected_only, configured=False):
        checkout = self.root / "source"
        app = checkout / "apps/day"
        (app / "native/src").mkdir(parents=True)
        for name in ("native/Cargo.lock", "native/src/bridge.rs", "nsh.json"):
            shutil.copyfile(bundle.ROOT / "apps/day" / name, app / name)
        desktop = checkout / "apps/desktop"
        visual = desktop / "visual-worker"
        archive = self.root / "quickjs.tar.gz"
        if not connected_only:
            visual.mkdir(parents=True)
            shutil.copyfile(bundle.ROOT / "apps/desktop/visual-worker/Cargo.toml", visual / "Cargo.toml")
            shutil.copyfile(bundle.ROOT / "apps/day/visual-worker.Cargo.lock", app / "visual-worker.Cargo.lock")
            (desktop / "updater").mkdir()
            shutil.copyfile(bundle.ROOT / "apps/desktop/updater/Cargo.lock", desktop / "updater/Cargo.lock")
            archive.write_bytes(b"fixture archive only")
        production = None
        if connected_only or configured:
            production = day.configuration(dict(
                PILOT_SIGNING_POLICY="private-adhoc",
                PILOT_UPDATER_PUBLIC_KEY=base64.b64encode(bytes([42]) * 32).decode(),
                PILOT_UPDATER_REPOSITORY="fixture/offline",
                PILOT_UPDATER_BUILD="100.1"))
        config = production or dict(schema=1, mode="unconfigured")
        calls = []
        compiled = dict(schema=1, kind="compiled-build-input", source=self.source,
                        recipe=bundle.digest(Path(day.__file__)), target=day.TARGET,
                        profile="release" if production else "debug",
                        compiler=self.compiler.strip().replace("\n", "|"),
                        updater_configuration=config)

        def fake_execute(args, *, cwd, env):
            args = [str(arg) for arg in args]
            calls.append(args)
            if args == [str(self.tools["rustc"]), "-vV"]:
                return self.compiler
            if args[-1] == "--version":
                return {"nsh":day.CLI_VERSION, "cargo":"cargo 1.99.1 (fixture)", "mbx":"mbx 1.30.0"}[Path(args[0]).name]
            if args[0] == "/usr/bin/lipo":
                return "arm64"
            if "metadata" in args:
                (visual / "Cargo.lock").write_text('[[package]]\nname="pilot-visual-worker"\nversion="0.1.0"\n')
                return "{}"
            if args[-1] == "--build-input-receipt":
                return json.dumps(compiled)
            if "--message-format=json-render-diagnostics" in args:
                self.assertNotIn("CARGO_TARGET_DIR", env)
                self.assertNotIn("CARGO_HOME", env)
                target = self.root / "global-mbx-target"
                target.mkdir(exist_ok=True)
                name = args[args.index("--bin") + 1]
                path = target / name
                path.write_bytes(("faux:" + name).encode())
                path.chmod(0o755)
                return json.dumps(dict(reason="compiler-artifact", target=dict(name=name), executable=str(path)))
            if "Connected.tsx" in args:
                built = Path(args[-1])
                built.mkdir()
                (built / "bundle.nshc").write_bytes(b"synthetic only")
                bundle.write_json(built / "capabilities.json", day.compiled_capabilities(day.host_methods(app)))
                bundle.write_json(built / "app.json", {"id":bundle.APP_ID})
            return ""

        output = self.root / "result"
        selection = {"connected_only": True} if connected_only else {}
        with patch.object(day, "CLI_SHA256", bundle.digest(self.tools["nsh"])), patch.object(day, "execute", side_effect=fake_execute), patch.object(day, "artifact_host") as checked:
            day.compile_snapshot(checkout, self.root, output, self.source, self.tools,
                                 {} if connected_only else {"PILOT_DAY_QUICKJS_ARCHIVE":str(archive)},
                                 production, **selection)
        metadata = bundle.read_json(output / "manifest.json")
        self.assertEqual(metadata["source"], self.source)
        self.assertEqual(metadata["recipe_sha256"], bundle.digest(Path(day.__file__)))
        self.assertFalse(metadata["installable_update"])
        self.assertEqual(metadata["updater_configuration"], config)
        self.assertEqual(metadata["compiled"]["pilot-desktop"], compiled)
        names = [call[call.index("--bin") + 1] for call in calls if "--bin" in call]
        expected = ["pilot-desktop"] if connected_only else [
            "pilot-desktop", day.ARTIFACT_HOST, "pilot-desktop-update-helper", "pilot-visual-worker"]
        self.assertEqual(names, expected)
        self.assertEqual([item["name"] for item in metadata["binaries"]], expected)
        bundle.receipt(output, self.source, expected)
        if connected_only:
            self.assertEqual(metadata["kind"], "connected-candidate-inputs")
            self.assertEqual(metadata["profile"], "release")
            self.assertEqual(list(metadata["compiled"]), ["pilot-desktop"])
            self.assertFalse(any(key.startswith("visual_") for key in metadata))
            self.assertFalse((output / "visual-metadata.json").exists())
            self.assertFalse(any("metadata" in call or any("prepare-visual-worker" in arg for arg in call) for call in calls))
            self.assertTrue(all("--release" in call for call in calls if "--bin" in call))
            checked.assert_not_called()
            with self.assertRaisesRegex(ValueError, "receipt mismatch"):
                bundle.receipt(output, self.source, ["pilot-desktop-update-helper"])
        else:
            self.assertEqual(metadata["kind"], "production-rust-inputs" if production else "development-rust-inputs")
            self.assertEqual(metadata["compiled"]["pilot-desktop-update-helper"], compiled)
            self.assertEqual(metadata["visual_manifest_sha256"], bundle.digest(visual / "Cargo.toml"))
            self.assertEqual(metadata["visual_lock_sha256"], bundle.digest(visual / "Cargo.lock"))
            self.assertTrue((output / "visual-metadata.json").is_file())
            checked.assert_called_once()
        bundle.checked_gui_resources(output / "nsh", output, self.source)
        self.assertTrue(any("Connected.tsx" in call for call in calls))
        self.assertFalse(any(any(word in ("package", "run", "nsh-cli", "codesign", "pnpm") for word in call) for call in calls))


class ArtifactHostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="day-artifact-direct-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "pilot-artifact-host"
        self.source, self.recipe = "a" * 40, "b" * 64
        self.identity = dict(schema=1, kind="nsh-source-host", runtime="nsh 0.5.0",
                             source=self.source, recipe=self.recipe)
        self.module = bundle.ROOT / day.HOST_MODULE

    def program(self, body):
        script = self.root / "program.py"
        script.write_text(body)
        self.binary.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(script)) + "\n")
        self.binary.chmod(0o755)

    def test_existing_node_transport_keeps_identity_and_empty_environment(self):
        self.program("import json,sys,os\nr=json.load(sys.stdin)\n"
            "assert r['action']=='compile' and len(sys.argv)==1\n"
            "assert 'HOME' not in os.environ and 'GH_TOKEN' not in os.environ\n"
            "print(json.dumps({'identity':" + repr(self.identity) + ", 'value':"
            "None}))\n")
        self.assertEqual(day.artifact_identity(self.binary, self.source, self.recipe, module=self.module), self.identity)
        for source, recipe in (("c" * 40, self.recipe), (self.source, "c" * 64)):
            with self.assertRaisesRegex(ValueError, "compiled source"):
                day.artifact_identity(self.binary, source, recipe, module=self.module)

    def test_node_transport_refuses_deadline_oversize_and_malformed_reply(self):
        for body in ("print('not json')", "print('x'*9000)", "import time\ntime.sleep(30)"):
            self.program(body)
            with self.assertRaisesRegex(ValueError, "compiled source"):
                day.artifact_identity(self.binary, self.source, self.recipe, module=self.module)

    def test_current_transport_cannot_overlay_the_requested_source(self):
        with patch.object(day.subprocess, "check_output", return_value=b"different bytes"):
            with self.assertRaisesRegex(ValueError, "immutable source"):
                day.artifact_identity(self.binary, self.source, self.recipe)

    def test_input_bytes_kind_modes_links_and_source_stay_checked(self):
        self.binary.write_bytes(b"\xcf\xfa\xed\xfe" + b"synthetic native bytes, never executed")
        self.binary.chmod(0o755)
        entry = dict(name=self.binary.name, bytes=self.binary.stat().st_size, sha256=bundle.digest(self.binary))
        value = dict(source=self.source, recipe_sha256=self.recipe, target=day.TARGET, binaries=[entry])
        bundle.write_json(self.root / "manifest.json", value)
        with patch.object(day, "artifact_identity", return_value=self.identity):
            expected = day.artifact_host(self.root, self.source)
            self.assertEqual(expected, dict(schema=1, identity=self.identity, bytes=entry["bytes"], sha256=entry["sha256"]))
            for mode in (0o777, 0o644):
                self.binary.chmod(mode)
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    day.artifact_host(self.root, self.source)
            self.binary.chmod(0o755)
            actual = self.binary.lstat()
            lstat = Path.lstat
            foreign = SimpleNamespace(st_mode=actual.st_mode, st_nlink=1,
                                      st_uid=day.os.geteuid() + 12345)
            with patch.object(Path, "lstat", autospec=True, side_effect=lambda path: foreign if path == self.binary else lstat(path)):
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    day.artifact_host(self.root, self.source)
            with self.assertRaisesRegex(ValueError, "source/target"):
                day.artifact_host(self.root, "c" * 40)
            original = self.binary.read_bytes()
            self.binary.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "receipt mismatch"):
                day.artifact_host(self.root, self.source)
            self.binary.write_bytes(original)
            self.binary.write_bytes(b"not native")
            entry.update(bytes=self.binary.stat().st_size, sha256=bundle.digest(self.binary))
            bundle.write_json(self.root / "manifest.json", value)
            with self.assertRaisesRegex(ValueError, "Mach-O"):
                day.artifact_host(self.root, self.source)
            self.binary.write_bytes(original)
            entry.update(bytes=self.binary.stat().st_size, sha256=bundle.digest(self.binary))
            bundle.write_json(self.root / "manifest.json", value)
            alias = self.root / "hardlink"
            alias.hardlink_to(self.binary)
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                day.artifact_host(self.root, self.source)
            alias.unlink()
            self.binary.rename(self.root / "saved")
            self.binary.symlink_to("saved")
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                day.artifact_host(self.root, self.source)


if __name__ == "__main__":
    unittest.main()
