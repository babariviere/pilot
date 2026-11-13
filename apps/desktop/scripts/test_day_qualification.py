"""Offline regression tests. Synthetic inputs never count as signed/native acceptance."""
import hashlib
import importlib.util
from pathlib import Path
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
        binding = patch.object(qualification.day_artifact_host, "checked")
        binding.start()
        self.addCleanup(binding.stop)

    def qualify(self, **kwargs):
        return qualification.qualify(self.source, self.inputs, **kwargs)

    def test_exact_inputs_are_relocatable_but_not_installable_or_accepted(self):
        expected = self.qualify()
        for key in ("installable_update", "signed_package", "native_acceptance"):
            self.assertIs(expected[key], False)
        self.assertEqual(self.receipt.call_count, 2)
        self.assertEqual(expected["inputs"], bundle.inventory(self.inputs))
        moved = self.root / "relocated inputs"
        self.inputs.rename(moved)
        self.assertEqual(qualification.qualify(self.source, moved), expected)

    def test_large_debug_binary_is_diagnostic_only_not_shipping_admission(self):
        binary = self.inputs / "pilot-desktop"
        with binary.open("wb") as stream:
            stream.truncate(257 * 1024**2)
        entry = self.manifest["binaries"][0]
        entry.update(bytes=binary.stat().st_size, sha256=bundle.digest(binary))
        bundle.write_json(self.inputs / "manifest.json", self.manifest)
        resources = bundle.read_json(self.inputs / "gui-resources.json")
        resources["executable"] = entry
        bundle.write_json(self.inputs / "gui-resources.json", resources)
        self.assertFalse(self.qualify()["installable_update"])
        with self.assertRaisesRegex(ValueError, "expanded byte policy"):
            bundle.inventory(self.inputs)
        # Exact executable names only. Logs/resources keep the ordinary limit.
        binary.rename(self.inputs / "oversized.log")
        with self.assertRaisesRegex(ValueError, "expanded byte policy"):
            qualification.debug_inventory(self.inputs)
        (self.inputs / "oversized.log").unlink()
        with binary.open("wb") as stream:
            stream.truncate(1024**3 + 1)
        with self.assertRaisesRegex(ValueError, "expanded byte policy"):
            qualification.debug_inventory(self.inputs)

    def test_day_debug_inventory_keeps_structural_resource_and_total_limits(self):
        extra = self.inputs / "extra"
        extra.mkdir()
        with self.assertRaisesRegex(ValueError, "Unsupported Day input"):
            qualification.debug_inventory(self.inputs)
        extra.rmdir()
        extra.symlink_to("pilot-desktop")
        with self.assertRaisesRegex(ValueError, "Unsafe Day input"):
            qualification.debug_inventory(self.inputs)
        extra.unlink()
        extra.hardlink_to(self.inputs / "pilot-desktop")
        with self.assertRaisesRegex(ValueError, "Unsupported Day input"):
            qualification.debug_inventory(self.inputs)
        extra.unlink()
        binary = self.inputs / "pilot-desktop"
        binary.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "Unsafe Day input"):
            qualification.debug_inventory(self.inputs)
        binary.chmod(0o755)
        with patch.object(bundle, "CAP_FILES", 3), self.assertRaisesRegex(ValueError, "total inventory policy"):
            qualification.debug_inventory(self.inputs)
        with patch.object(bundle, "CAP_BYTES", 1), self.assertRaisesRegex(ValueError, "byte policy|total inventory policy"):
            qualification.debug_inventory(self.inputs)
        with (self.inputs / "nsh/large.asset").open("wb") as stream:
            stream.truncate(257 * 1024**2)
        with self.assertRaisesRegex(ValueError, "expanded byte policy"):
            qualification.debug_inventory(self.inputs)

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
    def test_qualification_tools_cannot_overlay_a_different_source(self):
        def content(source, relative):
            self.assertEqual(source, "a" * 40)
            return (ROOT / relative).read_text()
        with patch.object(qualification, "source_file", side_effect=content):
            qualification.source_tools("a" * 40)
        with patch.object(qualification, "source_file", return_value="other source"):
            with self.assertRaisesRegex(ValueError, "tools must match the immutable source"):
                qualification.source_tools("a" * 40)

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

    def test_qualification_has_exact_source_callers_without_production_effects(self):
        workflow = (ROOT / ".github/workflows/day-qualification.yml").read_text()
        self.assertIn("  workflow_call:", workflow)
        self.assertIn("ref: ${{ inputs.ref }}", workflow)
        self.assertIn('[[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]]', workflow)
        self.assertIn('test "$(git rev-parse HEAD)" = "$SOURCE"', workflow)
        for guard in ("github.ref == 'refs/heads/main'", "github.event.repository.fork == false",
                      "inputs.ref == github.sha", "github.event_name == 'pull_request'",
                      "github.event_name == 'push'", "github.event.pull_request.base.ref == 'main'",
                      "github.event.pull_request.head.repo.full_name == github.repository", "persist-credentials: false"):
            self.assertIn(guard, workflow)
        for forbidden in ("  push:", "  workflow_dispatch:", "secrets:", "secrets.",
                          "contents: write", "secrets: inherit", "continue-on-error", "upload-artifact@",
                          "gui_release.py macos", "bundle_runtime.py bundle", "nsh.sh package"):
            self.assertNotIn(forbidden, workflow)
        callers = []
        for path in (ROOT / ".github/workflows").glob("*"):
            if "uses: ./.github/workflows/day-qualification.yml" in path.read_text():
                callers.append(path.name)
                call = path.read_text().split("  day-qualification:\n", 1)[1].split("\n  #", 1)[0]
                self.assertIn("ref: ${{ github.sha }}", call)
                self.assertNotIn("secrets:", call)
        self.assertEqual(sorted(callers), ["main.yaml", "pr.yaml"])
        pr = (ROOT / ".github/workflows/pr.yaml").read_text()
        self.assertIn("if: github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository && github.event.repository.fork == false", pr)
        self.assertIn("runs-on: macos-15\n", workflow)
        self.assertIn('test "$(uname -m)" = arm64', workflow)
        self.assertIn('test "$(xcodebuild -version | head -1)" = \'Xcode 26.2\'', workflow)
        self.assertIn('test "$(xcrun --sdk macosx --show-sdk-version)" = \'26.2\'', workflow)
        self.assertIn('day_ci_policy.py --source "$SOURCE"', workflow)
        for name in ("release.yaml", "gui-package.yml", "linux-package.yml"):
            self.assertNotIn("day_qualification", (ROOT / ".github/workflows" / name).read_text())
        self.assertIn("snapshot_rust(expected, rust, production=config)",
                      (ROOT / "apps/desktop/scripts/gui_release.py").read_text())

    def test_day_portable_tests_run_without_desktop_change_filter(self):
        workflow = (ROOT / ".github/workflows/tests.yaml").read_text()
        job = workflow.split("  day-contracts:\n", 1)[1].split("  node:\n", 1)[0]
        self.assertNotIn("if:", job)
        self.assertIn("day_build_inputs day_artifact_host day_qualification bundle_runtime gui_release", job)
        self.assertIn("discover -s apps/day/scripts -p 'test_*.py'", job)
        native = (ROOT / ".github/workflows/day-qualification.yml").read_text()
        self.assertIn("--frozen-lockfile --ignore-scripts", native)
        self.assertIn("NSH_DAY_CARGO_MODE: direct", native)
        self.assertNotIn("mise which mbx", native)
        self.assertNotIn("mr-boxington", native)
        self.assertIn("$stage/nsh/bin/nsh", native)
        self.assertIn(day.CLI_SHA256, native)
        self.assertIn("for file in App Plan Intake Update;", native)
        self.assertIn("--manifest-path apps/day/native/Cargo.toml --features macos-host --lib", native)
        self.assertNotIn("nsh.sh test Native", native)

    def test_shared_ci_keeps_security_checks_without_gpui_jobs(self):
        workflow = (ROOT / ".github/workflows/tests.yaml").read_text()
        for phase in ("updater-check", "updater-linux-tests", "updater-mac-tests", "power-check"):
            self.assertIn("ci.sh " + phase, workflow)
        self.assertIn("verify_update_lifecycle.py", workflow)
        self.assertEqual(workflow.count("DESKTOP_CI_SHARED_ONLY: '1'"), 2)
        for obsolete in ("rust-macos-bundle:", "rust-macos-release:", "ci.sh check\n",
                         "ci.sh native\n", "ci.sh nsh-native\n", "ci.sh mac-tests\n"):
            self.assertNotIn(obsolete, workflow)


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
