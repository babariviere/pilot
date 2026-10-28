"""Synthetic command/CI contracts only. Never builds Swift or qualifies a bundle."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import verify_macos_bundle as fixture


class MacosBundleRouteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.output = self.root / "qualification"
        self.source = "a" * 40
        self.commands = []
        self.environment = dict(GITHUB_ACTIONS="true", RUNNER_TEMP=str(self.root),
                                HOME="/must-not-use", PILOT_HOME="/must-not-use",
                                PILOT_NEXT_UPDATER_PRIVATE_KEY="must-not-inherit",
                                PI_CODING_AGENT_DIR="/must-not-use", NODE_OPTIONS="must-not-inherit")
        for context in [patch.dict(os.environ, self.environment),
                        patch.object(fixture.sys, "platform", "darwin"),
                        patch.object(fixture.platform, "machine", return_value="arm64"),
                        patch.object(fixture.bundle, "run", return_value=self.source),
                        patch.object(fixture.bundle, "native_closure", return_value=[]),
                        patch.object(fixture.subprocess, "run", side_effect=self.command)]:
            context.start()
            self.addCleanup(context.stop)

    def command(self, args, **options):
        self.commands.append((args, options))
        if str(args[1]).endswith("bundle_runtime.py"):
            action = args[2]
            if action in ("runtime", "native", "rust"):
                output = Path(args[args.index("--output") + 1])
                output.mkdir()
                (output / "manifest.json").write_text("{}")
            elif action == "bundle":
                app = Path(args[args.index("--output") + 1])
                resources = app / "Contents/Resources"
                resources.mkdir(parents=True)
                for name in ("bundled-runtime", "native-inputs", "rust-inputs", "updater-inputs"):
                    (resources / (name + ".json")).write_text("{}")
                binary = app / "Contents/MacOS/pilot-desktop"
                binary.parent.mkdir()
                binary.write_text("synthetic, never executed")
            elif action == "verify":
                self.assertTrue(Path(args[3]).is_dir())
                for name in ("runtime", "native", "rust"):
                    self.assertFalse((self.output / name).exists(), "inputs must be removed before verification")
        return subprocess.CompletedProcess(args, 0)

    def test_exact_source_real_stages_relocate_before_offline_smoke_and_help(self):
        fixture.qualify(self.source, self.output)
        commands = [args for args, _ in self.commands]
        stages = [args for args in commands if len(args) > 2 and str(args[1]).endswith("bundle_runtime.py")]
        self.assertEqual([args[2] for args in stages], ["runtime", "native", "rust", "bundle", "verify"])
        for args in stages[:-1]:
            self.assertEqual(args[args.index("--source") + 1], self.source)
        moved = self.output / "relocated GUI/Pilot Next.app"
        self.assertEqual(stages[-1][3], str(moved))
        smoke = commands[-2]
        self.assertTrue(smoke[1].endswith("apps/macos/scripts/check-runtime.sh"))
        self.assertEqual(smoke[-1], str(moved / "Contents/Resources/runtime"))
        self.assertEqual(commands[-1], [str(moved / "Contents/MacOS/pilot-desktop"), "--help"])
        for _, options in self.commands:
            env = options["env"]
            self.assertEqual(env["PILOT_SWIFT_JOBS"], "2")
            self.assertEqual(env["CARGO_BUILD_JOBS"], "2")
            self.assertEqual(env["HOME"], str(self.output / "home"))
            self.assertTrue(env["TMPDIR"].startswith(str(self.output)))
            for key in self.environment:
                if key.startswith(("PILOT_", "PI_", "NODE_")):
                    self.assertNotIn(key, env)
        report = json.loads((self.output / "evidence/report.json").read_text())
        self.assertTrue(report["passed"])
        self.assertFalse(report["full_acceptance"])
        self.assertFalse(report["gui_startup_executed"])
        self.assertEqual(report["source"], self.source)
        self.assertEqual(len(report["steps"]), 8)
        self.assertIn(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(moved)], commands)
        self.assertTrue(all(item["seconds"] >= 0 for item in report["steps"]))
        self.assertTrue((self.output / "evidence/bundled-runtime.json").is_file())

    def test_failure_propagates_and_keeps_failed_stage_evidence(self):
        with patch.object(fixture.subprocess, "run", side_effect=subprocess.CalledProcessError(42, ["synthetic"])):
            with self.assertRaises(subprocess.CalledProcessError):
                fixture.qualify(self.source, self.output)
        report = json.loads((self.output / "evidence/report.json").read_text())
        self.assertFalse(report["passed"])
        self.assertFalse(report["full_acceptance"])
        self.assertEqual(report["steps"][0]["exit_code"], 42)
        self.assertEqual(len(report["steps"]), 1)

    def test_wrong_source_host_non_ci_and_unsafe_output_refuse_before_builds(self):
        for changes in [dict(GITHUB_ACTIONS="false"), dict(RUNNER_TEMP=str(self.root / "different"))]:
            with patch.dict(os.environ, changes), self.assertRaises(ValueError):
                fixture.qualify(self.source, self.output)
        with patch.object(fixture.platform, "machine", return_value="x86_64"), self.assertRaises(ValueError):
            fixture.qualify(self.source, self.output)
        with patch.object(fixture.bundle, "run", return_value="b" * 40), self.assertRaises(ValueError):
            fixture.qualify(self.source, self.output)
        self.assertEqual(self.commands, [])
        self.assertFalse(self.output.exists())
        self.output.mkdir()
        marker = self.output / "retained"
        marker.write_text("keep")
        with self.assertRaises(FileExistsError):
            fixture.qualify(self.source, self.output)
        self.assertEqual(marker.read_text(), "keep")

    def test_workflow_is_non_release_real_macos_job_with_private_outputs(self):
        workflow = (fixture.bundle.ROOT / ".github/workflows/tests.yaml").read_text()
        job = workflow.split("\n  rust-macos-bundle:\n", 1)[1].split("\n  rust-", 1)[0]
        for required in ("runs-on: macos-15", "persist-credentials: false", "python-version: '3.13'",
                         "actions/setup-node@v4", "pnpm/action-setup@v4", "ci.sh bootstrap",
                         "verify_macos_bundle.py", '--source "$GITHUB_SHA"',
                         '"$RUNNER_TEMP/macos-bundle"', "actions/upload-artifact@v4",
                         "if: ${{ !cancelled() }}", "retention-days: 7"):
            self.assertIn(required, job)
        for forbidden in ("secrets.", "vars.", "gui_release.py", "release.yaml", "workflow_dispatch",
                          "needs:", "continue-on-error:", "desktop-release-build", "gui-package.yml"):
            self.assertNotIn(forbidden, job)


if __name__ == "__main__":
    unittest.main()
