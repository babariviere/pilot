"""Private offline recipe fixtures. Fake compilers/resources are NOT native acceptance."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import bundle_runtime as bundle
import day_build_inputs as day


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

    def test_environment_is_private_offline_and_drops_ambient_authority(self):
        inherited = dict(PATH="/usr/bin:/bin", PILOT_NEXT_UPDATER_PUBLIC_KEY="fixture",
                         GH_TOKEN="never-forward", NODE_OPTIONS="--import hostile", RUSTFLAGS="bad",
                         MBX_SOCKET="bad", RUSTC_WRAPPER="bad", NSH_APP_DIR="bad",
                         npm_config_ignore_scripts="false")
        env = day.environment(self.root, self.tools, inherited, None)
        for key in inherited.keys() - {"PATH", "npm_config_ignore_scripts"}:
            self.assertNotIn(key, env)
        for key in ("HOME", "CARGO_HOME", "MBX_CACHE_DIR"):
            self.assertTrue(Path(env[key]).is_relative_to(self.root))
        for key in ("CARGO_INCREMENTAL", "MBX_LEARNED_INCREMENTAL", "MBX_EAGER_INCREMENTAL", "MBX_SEED_INCREMENTAL"):
            self.assertEqual(env[key], "0")
        self.assertEqual(env["CARGO_NET_OFFLINE"], "true")
        self.assertEqual(env["CARGO_BUILD_JOBS"], "1")
        self.assertEqual(env["npm_config_ignore_scripts"], "true")
        self.assertEqual(env["RUSTUP_AUTO_INSTALL"], "0")

    def test_missing_production_configuration_refuses_not_fixture_fallback(self):
        import gui_release
        with self.assertRaisesRegex(ValueError, "Missing release configuration"):
            gui_release.configuration({})
        with self.assertRaises(KeyError):
            day.environment(self.root, self.tools, {}, {})

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
        for changes in ({"clipboard":True}, {"extra":False}, {"process":{"execute":["sh"], "env":[], "exit":False}},
                        {"fs":{"read":["/"], "write":[]}}):
            bundle.write_json(built / "capabilities.json", original | changes)
            with self.assertRaisesRegex(ValueError, "capabilities"):
                day.resource_closure(built, self.root / "nsh", ["day.today.read"])

    def test_build_uses_real_cargo_artifact_not_runner_name_guessing(self):
        target = self.root / "target"
        target.mkdir()
        binary = target / "pilot-desktop"
        binary.write_bytes(b"faux")
        raw = json.dumps(dict(reason="compiler-artifact", target=dict(name="pilot-desktop"), executable=str(binary)))
        env = dict(CARGO_TARGET_DIR=str(target))
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
        checkout = self.root / "source"
        app = checkout / "apps/day"
        (app / "native/src").mkdir(parents=True)
        for name in ("native/Cargo.lock", "native/src/bridge.rs", "nsh.json"):
            shutil.copyfile(bundle.ROOT / "apps/day" / name, app / name)
        desktop = checkout / "apps/desktop"
        visual = desktop / "visual-worker"
        visual.mkdir(parents=True)
        shutil.copyfile(bundle.ROOT / "apps/desktop/visual-worker/Cargo.toml", visual / "Cargo.toml")
        shutil.copyfile(bundle.ROOT / "apps/desktop/Cargo.lock", desktop / "Cargo.lock")
        (desktop / "updater").mkdir()
        shutil.copyfile(bundle.ROOT / "apps/desktop/updater/Cargo.lock", desktop / "updater/Cargo.lock")
        archive = self.root / "quickjs.tar.gz"
        archive.write_bytes(b"fixture archive only")
        calls = []
        compiled = dict(schema=1, kind="compiled-build-input", source=self.source,
                        recipe=bundle.digest(Path(day.__file__)), target=day.TARGET, profile="debug",
                        compiler=self.compiler.strip().replace("\n", "|"),
                        updater_configuration=dict(schema=1, mode="unconfigured"))

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
                target = Path(env["CARGO_TARGET_DIR"])
                target.mkdir(exist_ok=True)
                name = args[args.index("--bin") + 1]
                path = target / name
                path.write_bytes(("faux:" + name).encode())
                return json.dumps(dict(reason="compiler-artifact", target=dict(name=name), executable=str(path)))
            if "Connected.tsx" in args:
                built = Path(args[-1])
                built.mkdir()
                (built / "bundle.nshc").write_bytes(b"synthetic only")
                bundle.write_json(built / "capabilities.json", day.compiled_capabilities(day.host_methods(app)))
                bundle.write_json(built / "app.json", {"id":bundle.APP_ID})
            return ""

        output = self.root / "result"
        with patch.object(day, "CLI_SHA256", bundle.digest(self.tools["nsh"])), patch.object(day, "execute", side_effect=fake_execute):
            day.compile_snapshot(checkout, self.root, output, self.source, self.tools,
                                 {"PILOT_DAY_QUICKJS_ARCHIVE":str(archive)})
        metadata = bundle.read_json(output / "manifest.json")
        self.assertEqual(metadata["source"], self.source)
        self.assertFalse(metadata["installable_update"])
        self.assertEqual(metadata["updater_configuration"], {"schema":1,"mode":"unconfigured"})
        self.assertEqual(metadata["compiled"]["pilot-desktop"], metadata["compiled"]["pilot-desktop-update-helper"])
        bundle.receipt(output, self.source, ["pilot-desktop", "pilot-visual-worker", "pilot-desktop-update-helper"])
        bundle.checked_gui_resources(output / "nsh", output, self.source)
        self.assertTrue(any("Connected.tsx" in call for call in calls))
        self.assertFalse(any(any(word in ("package", "run", "nsh-cli", "codesign", "pnpm") for word in call) for call in calls))


if __name__ == "__main__":
    unittest.main()
