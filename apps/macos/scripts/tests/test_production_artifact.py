import base64
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.dont_write_bytecode = True
from production_artifact import production_artifact


class ProductionArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.commit = "a" * 40
        self.env = {
            "PILOT_UPDATE_REPOSITORY": "owner/repo",
            "SPARKLE_PUBLIC_KEY": base64.b64encode(bytes(range(32))).decode(),
            "BUNDLE_VERSION": "10010.2",
        }
        self.info = {
            "CFBundleShortVersionString": "1.2.3", "CFBundleVersion": "10010.2",
            "PilotUpdateRepository": self.env["PILOT_UPDATE_REPOSITORY"],
            "SUPublicEDKey": self.env["SPARKLE_PUBLIC_KEY"],
        }
        self.archive = self.root / "Pilot-arm64.zip"
        self.manifest = self.root / "production-artifact.json"
        self.write_archive()

    def write_archive(self, content=b"original executable"):
        with zipfile.ZipFile(self.archive, "w") as package:
            package.writestr("Pilot.app/Contents/Info.plist", plistlib.dumps(self.info))
            package.writestr("Pilot.app/Contents/MacOS/Pilot", content)

    def run_action(self, action, commit=None, app_version="1.2.3", env=None):
        production_artifact(action, self.root, commit or self.commit, app_version,
                            self.env if env is None else env)

    def test_round_trip_preserves_archive_bytes(self):
        original = self.archive.read_bytes()
        self.run_action("create")
        self.run_action("verify")
        self.assertEqual(self.archive.read_bytes(), original)
        manifest = json.loads(self.manifest.read_text())
        self.assertEqual(manifest["commit"], self.commit)
        self.assertEqual(manifest["buildVersion"], "10010.2")
        self.assertEqual(manifest["archive"]["size"], len(original))

    def test_different_release_commit_is_rejected(self):
        self.run_action("create")
        with self.assertRaisesRegex(ValueError, "release source"):
            self.run_action("verify", commit="b" * 40)

    def test_different_release_version_is_rejected(self):
        self.run_action("create")
        with self.assertRaisesRegex(ValueError, "version"):
            self.run_action("verify", app_version="1.2.4")

    def test_modified_archive_is_rejected_even_at_same_size(self):
        self.run_action("create")
        size = self.archive.stat().st_size
        self.write_archive(b"modified executable")
        self.assertEqual(self.archive.stat().st_size, size)
        with self.assertRaisesRegex(ValueError, "archive"):
            self.run_action("verify")

    def test_missing_or_invalid_manifest_fails_closed(self):
        with self.assertRaises(FileNotFoundError):
            self.run_action("verify")
        for value in ["{}", "invalid", "x" * (64 * 1024 + 1)]:
            self.manifest.write_text(value)
            with self.subTest(value=value[:8]), self.assertRaises(ValueError):
                self.run_action("verify")

    def test_each_manifest_identity_and_checksum_field_is_checked(self):
        self.run_action("create")
        manifest = json.loads(self.manifest.read_text())
        for field, value in [("schemaVersion", 2), ("version", "1.2.4"),
                             ("buildVersion", "10011.1"), ("commit", "b" * 40),
                             ("archive", {**manifest["archive"], "sha256": "0" * 64}),
                             ("archive", {**manifest["archive"], "name": "other.zip"}),
                             ("archive", {**manifest["archive"], "size": 1})]:
            self.manifest.write_text(json.dumps({**manifest, field: value}))
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.run_action("verify")

    def test_changed_or_missing_public_configuration_is_rejected(self):
        self.run_action("create")
        for key in ["PILOT_UPDATE_REPOSITORY", "SPARKLE_PUBLIC_KEY"]:
            for value in ["different", ""]:
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, key):
                    self.run_action("verify", env={**self.env, key: value})

    def test_verify_does_not_require_private_keys_or_recompute_attempt_number(self):
        self.run_action("create")
        self.run_action("verify", env={k: v for k, v in self.env.items() if k != "BUNDLE_VERSION"})

    def test_create_requires_the_expected_build_version(self):
        with self.assertRaisesRegex(ValueError, "BUNDLE_VERSION"):
            self.run_action("create", env={**self.env, "BUNDLE_VERSION": "10010.1"})

    def test_development_app_is_rejected(self):
        self.info["PilotRepoPath"] = "/checkout"
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "standalone"):
            self.run_action("create")

    def test_invalid_source_identity_or_build_version_is_rejected(self):
        for commit in ["short", "a" * 40 + "\n"]:
            with self.subTest(commit=commit), self.assertRaises(ValueError):
                self.run_action("create", commit=commit)
        for build in ["0", "invalid"]:
            self.info["CFBundleVersion"] = build
            self.write_archive()
            with self.subTest(build=build), self.assertRaises(ValueError):
                self.run_action("create")

    def test_oversized_plist_is_rejected(self):
        self.info["padding"] = "x" * (64 * 1024)
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "size"):
            self.run_action("create")

    def test_cli_can_create_then_verify_without_apple_tools(self):
        script = str(Path(__file__).resolve().parents[1] / "production_artifact.py")
        for action in ["create", "verify"]:
            result = subprocess.run([sys.executable, "-B", script, action, str(self.root),
                                     self.commit, "1.2.3"], env={**os.environ, **self.env},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
