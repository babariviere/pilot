"""Offline regression tests. Synthetic inputs never count as signed/native acceptance."""
import hashlib
import importlib.util
from pathlib import Path
import shutil
import tempfile
import subprocess
import tomllib
import unittest
from unittest.mock import patch

import bundle_runtime as bundle
import day_build_inputs as day
import day_qualification as qualification

ROOT = bundle.ROOT


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="day-qualification-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inputs = self.root / "inputs"
        self.inputs.mkdir()
        self.source = "a" * 40
        self.recipe = "synthetic recipe only\n"
        self.methods = 'pub const METHODS: &[&str] = &["day.today.read"];'
        self.compiler = "rustc 1.99.1 (synthetic)\nhost: " + day.TARGET + "\n"
        binaries = []
        for name in qualification.BINARIES:
            path = self.inputs / name
            path.write_bytes(b"faux binary, never executed: " + name.encode())
            path.chmod(0o755)
            binaries.append(dict(name=name, bytes=path.stat().st_size, sha256=bundle.digest(path)))
        self.compiled = dict(schema=1, kind="compiled-build-input", source=self.source,
                             recipe=hashlib.sha256(self.recipe.encode()).hexdigest(), target=day.TARGET,
                             profile="debug", compiler=self.compiler.strip().replace("\n", "|"),
                             updater_configuration=dict(schema=1, mode="unconfigured"))
        self.manifest = dict(schema=1, source=self.source, target=day.TARGET,
                             kind="development-rust-inputs", profile="dev", installable_update=False,
                             deployment_target="15.0", compiler=self.compiler,
                             recipe_sha256=self.compiled["recipe"], tools={"nsh": {"sha256": day.CLI_SHA256}},
                             updater_configuration=self.compiled["updater_configuration"], binaries=binaries,
                             compiled={name:self.compiled for name in qualification.BINARIES[:2]})
        bundle.write_json(self.inputs / "manifest.json", self.manifest)
        resources = self.inputs / "nsh"
        resources.mkdir()
        (resources / "bundle.nshc").write_bytes(b"fixture bytecode, never executed")
        bundle.write_json(resources / "capabilities.json", day.compiled_capabilities(["day.today.read"]))
        bundle.write_json(resources / "app.json", {"id": bundle.APP_ID})
        bundle.write_json(self.inputs / "gui-resources.json", dict(schema=1, kind="nsh-ui-resources",
            source=self.source, target=day.TARGET, nsh_release=bundle.NSH_RELEASE,
            executable=binaries[0], files=bundle.inventory(resources)))
        def source_file(source, relative):
            self.assertEqual(source, self.source)
            return self.recipe if relative.endswith("day_build_inputs.py") else self.methods
        self.source_patch = patch.object(qualification, "source_file", side_effect=source_file)
        self.source_patch.start()
        self.addCleanup(self.source_patch.stop)
        self.receipt_patch = patch.object(day, "compiled_receipt", return_value=self.compiled)
        self.receipt = self.receipt_patch.start()
        self.addCleanup(self.receipt_patch.stop)

    def qualify(self, **kwargs):
        return qualification.qualify(self.source, self.inputs, **kwargs)

    def test_exact_inputs_are_relocatable_but_not_installable_or_accepted(self):
        expected = self.qualify()
        for key in ("installable_update", "signed_package", "native_acceptance"):
            self.assertIs(expected[key], False)
        self.assertEqual(self.receipt.call_count, 2)
        moved = self.root / "relocated inputs"
        self.inputs.rename(moved)
        self.assertEqual(qualification.qualify(self.source, moved), expected)

    def test_source_recipe_target_tool_and_production_substitution_refuse(self):
        for key, bad in (("source", "b" * 40), ("target", "x86_64-unknown-linux-gnu"),
                         ("kind", "production-rust-inputs"), ("profile", "release"),
                         ("installable_update", True), ("recipe_sha256", "0" * 64),
                         ("compiler", "rustc 1.98.1\nhost: " + day.TARGET),
                         ("tools", {"nsh": {"sha256": "0" * 64}}),
                         ("updater_configuration", {"schema": 1, "mode": "configured"})):
            with self.subTest(key=key):
                bundle.write_json(self.inputs / "manifest.json", dict(self.manifest, **{key:bad}))
                with self.assertRaises(ValueError):
                    self.qualify()
        bundle.write_json(self.inputs / "manifest.json", self.manifest)
        with self.assertRaisesRegex(ValueError, "immutable"):
            qualification.qualify("main", self.inputs)

    def test_missing_extra_and_changed_executable_receipts_refuse(self):
        for entries in (self.manifest["binaries"][:-1], self.manifest["binaries"] * 2):
            bundle.write_json(self.inputs / "manifest.json", dict(self.manifest, binaries=entries))
            with self.assertRaisesRegex(ValueError, "inventory"):
                self.qualify()
        bundle.write_json(self.inputs / "manifest.json", self.manifest)
        (self.inputs / "pilot-desktop").write_bytes(b"different")
        with self.assertRaisesRegex(ValueError, "receipt mismatch"):
            self.qualify()

    def test_changed_compiled_helper_receipt_refuses(self):
        self.receipt.side_effect = [self.compiled, dict(self.compiled, source="b" * 40)]
        with self.assertRaisesRegex(ValueError, "compiled input receipt"):
            self.qualify()

    def test_resource_inventory_release_and_host_grant_cannot_be_relabelled(self):
        receipt = self.inputs / "gui-resources.json"
        original = bundle.read_json(receipt)
        for bad in (dict(original, nsh_release={"tag":"v0.4.0", "source":"b" * 40}),
                    dict(original, source="b" * 40)):
            bundle.write_json(receipt, bad)
            with self.assertRaises(ValueError):
                self.qualify()
        bundle.write_json(receipt, original)
        bundle.write_json(self.inputs / "nsh/capabilities.json", {"host": ["*"]})
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.qualify()
        bundle.write_json(receipt, dict(original, files=bundle.inventory(self.inputs / "nsh")))
        with self.assertRaisesRegex(ValueError, "native grant"):
            self.qualify()

    def test_full_package_preflight_checks_shared_runtime_and_native_source_receipts(self):
        runtime, native = self.root / "runtime", self.root / "native"
        runtime.mkdir()
        native.mkdir()
        with self.assertRaisesRegex(ValueError, "together"):
            self.qualify(runtime=runtime)
        bundle.write_json(runtime / "package.json", {"version":"1.2.3"})
        build = dict(schema=1, source=self.source, platform="darwin", arch="arm64",
                     version="1.2.3", node="24.21.0", protocol=1)
        for name in bundle.REQUIRED:
            path = runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_bytes(b"shared runtime fixture")
        bundle.write_json(runtime / "runtime-build.json", build)
        entries = []
        for name in ("PilotPower", "PilotSystemEvents"):
            path = native / name
            path.write_bytes(b"helper fixture")
            entries.append(dict(name=name, bytes=path.stat().st_size, sha256=bundle.digest(path)))
        bundle.write_json(native / "manifest.json", dict(schema=1, source=self.source,
                          target=day.TARGET, binaries=entries))
        self.assertEqual(self.qualify(runtime=runtime, native=native)["runtime_build"], build)
        bundle.write_json(runtime / "runtime-build.json", dict(build, source="b" * 40))
        with self.assertRaisesRegex(ValueError, "Runtime build identity"):
            self.qualify(runtime=runtime, native=native)
        bundle.write_json(runtime / "runtime-build.json", build)
        (native / "PilotSystemEvents").unlink()
        with self.assertRaisesRegex(ValueError, "Executable receipt"):
            self.qualify(runtime=runtime, native=native)


class WorkflowTests(unittest.TestCase):
    def test_cli_native_testing_and_runner_use_one_tagged_release(self):
        day.release_lock(ROOT / "apps/day/native/Cargo.lock")
        day.release_lock(ROOT / "apps/day/fixtures/rust-today/Cargo.lock")
        runner = tomllib.loads((ROOT / "apps/day/runner.Cargo.lock").read_text())["package"]
        native = {item["name"]: item for item in
                  tomllib.loads((ROOT / "apps/day/native/Cargo.lock").read_text())["package"]
                  if item["name"].startswith("nsh-")}
        actual = [item for item in runner if item["name"].startswith("nsh-")
                  and not item["name"].startswith("nsh-app-")]
        self.assertTrue(actual)
        for item in actual:
            self.assertEqual(item["version"], "0.5.0")
            self.assertEqual(item["source"], day.REGISTRY)
            if item["name"] in native:
                self.assertEqual(item["checksum"], native[item["name"]]["checksum"])
        self.assertIn("nsh-testing", {item["name"] for item in actual})
        self.assertEqual(bundle.NSH_RELEASE, dict(tag="v0.5.0",
                         source="f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1"))

    def test_shipping_source_and_signing_boundaries_stay_independent_of_day(self):
        release = (ROOT / ".github/workflows/release.yaml").read_text()
        package = (ROOT / ".github/workflows/gui-package.yml").read_text()
        self.assertIn('if [ -n "$RELEASE_SHA" ] && [ "$RELEASE_SHA" != "$tag_sha" ]', release)
        self.assertEqual(release.count("ref: ${{ needs.target.outputs.sha }}"), 3)
        self.assertIn("ref: ${{ inputs.ref }}", package)
        self.assertIn('test "$(git rev-parse HEAD)" = "$RELEASE_SOURCE"', package)
        self.assertNotIn("secrets: inherit", release + package)
        self.assertNotIn("day-qualification.yml", release + package)
        linux = package.split("      - name: Sign qualified Linux full-payload inventory", 1)[1]
        self.assertIn("if: inputs.platform == 'linux'", linux)
        self.assertIn("PILOT_NEXT_UPDATER_PRIVATE_KEY: ${{ secrets.PILOT_NEXT_UPDATER_PRIVATE_KEY }}", linux)

    def test_qualification_has_no_automatic_caller_or_production_effects(self):
        workflow = (ROOT / ".github/workflows/day-qualification.yml").read_text()
        self.assertIn("  workflow_call:", workflow)
        self.assertIn("ref: ${{ inputs.ref }}", workflow)
        self.assertIn('[[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]]', workflow)
        self.assertIn('test "$(git rev-parse HEAD)" = "$SOURCE"', workflow)
        for guard in ("github.ref == 'refs/heads/main'", "github.event.repository.fork == false",
                      "github.event_name != 'pull_request'", "persist-credentials: false"):
            self.assertIn(guard, workflow)
        for forbidden in ("  push:", "  workflow_dispatch:", "secrets:", "secrets.",
                          "contents: write", "secrets: inherit", "continue-on-error", "upload-artifact@",
                          "gui_release.py macos", "bundle_runtime.py bundle", "nsh.sh package"):
            self.assertNotIn(forbidden, workflow)
        for path in (ROOT / ".github/workflows").glob("*"):
            if path.name != "day-qualification.yml":
                self.assertNotIn("uses: ./.github/workflows/day-qualification.yml", path.read_text())
        for name in ("release.yaml", "gui-package.yml", "linux-package.yml"):
            self.assertNotIn("day_qualification", (ROOT / ".github/workflows" / name).read_text())
        self.assertIn("snapshot_rust(expected, rust, production=config)",
                      (ROOT / "apps/desktop/scripts/gui_release.py").read_text())

    def test_day_portable_tests_run_without_desktop_change_filter(self):
        workflow = (ROOT / ".github/workflows/tests.yaml").read_text()
        job = workflow.split("  day-contracts:\n", 1)[1].split("  node:\n", 1)[0]
        self.assertNotIn("if:", job)
        self.assertIn("day_build_inputs day_qualification bundle_runtime gui_release", job)
        self.assertIn("discover -s apps/day/scripts -p 'test_*.py'", job)
        native = (ROOT / ".github/workflows/day-qualification.yml").read_text()
        self.assertIn("--frozen-lockfile --ignore-scripts", native)
        self.assertIn("tools: mr-boxington@1.30.0", native)
        self.assertIn("mise which mbx", native)
        self.assertIn("$stage/nsh/bin/nsh", native)
        self.assertIn(day.CLI_SHA256, native)
        self.assertIn("for file in App Plan Intake Update;", native)
        self.assertIn("--manifest-path apps/day/native/Cargo.toml --lib", native)
        self.assertNotIn("nsh.sh test Native", native)


class DependencyPreparationTests(unittest.TestCase):
    def test_preparation_fetches_only_locks_and_never_builds_or_rewrites_source(self):
        spec = importlib.util.spec_from_file_location("prepare_day", ROOT / "apps/desktop/scripts/prepare-day-qualification.py")
        prepare = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(prepare)
        calls = []
        def run(args, **kwargs):
            args = [str(arg) for arg in args]
            calls.append(args)
            self.assertTrue(kwargs["check"])
            if "metadata" in args:
                path = Path(args[-1])
                self.assertTrue(path.read_text().endswith("\n[workspace]\n"))
                self.assertEqual((path.parent / "Cargo.lock").read_bytes(),
                                 (ROOT / "apps/desktop/Cargo.lock").read_bytes())
                (path.parent / "Cargo.lock").write_text('[[package]]\nname="pilot-visual-worker"\nversion="0.1.0"\n')
        before = {path:bundle.digest(path) for path in (ROOT / "apps/desktop/visual-worker/Cargo.toml",
                   ROOT / "apps/desktop/Cargo.lock", ROOT / "apps/day/native/Cargo.lock")}
        with patch.object(prepare.subprocess, "run", side_effect=run):
            prepare.main()
        self.assertEqual(len(calls), 5)
        self.assertEqual([args[1] for args in calls], ["fetch", "fetch", "metadata", "fetch",
                         str(ROOT / "apps/desktop/scripts/prepare-visual-worker.py")])
        for args in (calls[0], calls[1], calls[3]):
            self.assertIn("--locked", args)
            self.assertIn(day.TARGET, args)
        self.assertTrue(all(bundle.digest(path) == digest for path, digest in before.items()))
        with patch.object(prepare.subprocess, "run", side_effect=subprocess.CalledProcessError(42, "fetch")):
            with self.assertRaises(subprocess.CalledProcessError):
                prepare.main()


if __name__ == "__main__":
    unittest.main()
