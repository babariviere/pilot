import base64
from pathlib import Path
import plistlib
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.dont_write_bytecode = True
from release_metadata import SPARKLE, appcast, newer_than_latest, prepare_runtime, validate_symlinks, write_plist


class ReleaseMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.plist"
        self.output = self.root / "Info.plist"
        self.info = {
            "CFBundleVersion": "1", "CFBundleShortVersionString": "0.1.0",
            "PilotRepoPath": "@PILOT_REPO@", "SUShowReleaseNotes": False,
        }
        self.source.write_bytes(plistlib.dumps(self.info))
        self.env = {
            "BUNDLE_VERSION": "12345.2", "PILOT_UPDATE_REPOSITORY": "owner/private-repo",
            "SPARKLE_PUBLIC_KEY": base64.b64encode(bytes(range(32))).decode(),
        }

    def test_release_removes_checkout_and_preserves_owned_info_keys(self):
        write_plist(self.source, self.output, "/absolute/checkout", True, self.env)
        info = plistlib.loads(self.output.read_bytes())
        self.assertNotIn("PilotRepoPath", info)
        self.assertNotIn(b"/absolute/checkout", self.output.read_bytes())
        self.assertEqual(info["PilotUpdateRepository"], "owner/private-repo")
        self.assertEqual(info["CFBundleVersion"], "12345.2")
        self.assertEqual(info["SUPublicEDKey"], self.env["SPARKLE_PUBLIC_KEY"])
        self.assertFalse(info["SUShowReleaseNotes"])

    def test_development_retains_repo_path(self):
        write_plist(self.source, self.output, "/checkout", env={})
        self.assertEqual(plistlib.loads(self.output.read_bytes())["PilotRepoPath"], "/checkout")

    def test_release_requires_all_configuration(self):
        for key in self.env:
            with self.subTest(key=key), self.assertRaises(ValueError):
                write_plist(self.source, self.output, "/checkout", True,
                            {k: v for k, v in self.env.items() if k != key})

    def test_rejects_invalid_build_repository_and_key(self):
        for key, values in {
            "BUNDLE_VERSION": ["sha123", "0", "1.2.3.4", "-1", "1&2"],
            "PILOT_UPDATE_REPOSITORY": ["owner", "owner/repo/extra", "https://github.com/a/b"],
            "SPARKLE_PUBLIC_KEY": ["not base64!", base64.b64encode(b"short").decode()],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    write_plist(self.source, self.output, "/checkout", True, {**self.env, key: value})

    def test_appcast_references_exact_authenticated_api_asset(self):
        signature = base64.b64encode(bytes(64)).decode()
        xml = appcast("owner/private-repo", "123456", "12345.2", "0.1.0 & preview", signature, 987)
        item = ET.fromstring(xml).find("channel/item")
        self.assertEqual(item.find(f"{{{SPARKLE}}}version").text, "12345.2")
        self.assertEqual(item.find(f"{{{SPARKLE}}}shortVersionString").text, "0.1.0 & preview")
        self.assertEqual(item.find(f"{{{SPARKLE}}}minimumSystemVersion").text, "14.0")
        enclosure = item.find("enclosure")
        self.assertEqual(enclosure.attrib["url"],
                         "https://api.github.com/repos/owner/private-repo/releases/assets/123456")
        self.assertEqual(enclosure.attrib[f"{{{SPARKLE}}}edSignature"], signature)
        self.assertEqual(enclosure.attrib["length"], "987")
        self.assertNotIn(b"releaseNotes", xml)
        self.assertNotIn(b"github.com/owner/private-repo/releases/download", xml)

    def test_rejects_bad_asset_id_length_signature(self):
        signature = base64.b64encode(bytes(64)).decode()
        for asset, sig, length in [("", signature, 1), ("123\n456", signature, 1),
                                   ("1", signature, 0), ("1", "bad", 1)]:
            with self.subTest(asset=asset), self.assertRaises(ValueError):
                appcast("owner/repo", asset, "123.1", "0.1.0", sig, length)

    def runtime(self):
        runtime = self.root / "runtime"
        workspace = runtime / "packages/daemon"
        workspace.mkdir(parents=True)
        (workspace / "package.json").write_text('{}')
        (runtime / "node_modules/@pilot").mkdir(parents=True)
        return runtime

    def test_workspace_symlink_survives_relocation(self):
        runtime = self.runtime()
        (runtime / "node_modules/@pilot/daemon").symlink_to("../../packages/daemon")
        validate_symlinks(runtime)
        copy = self.root / "relocated/runtime"
        shutil.copytree(runtime, copy, symlinks=True)
        shutil.rmtree(runtime)
        validate_symlinks(copy)
        self.assertTrue((copy / "node_modules/@pilot/daemon/package.json").is_file())

    def test_rejects_absolute_escaping_or_dangling_links(self):
        runtime = self.runtime()
        link = runtime / "node_modules/@pilot/daemon"
        for target in [str(runtime / "packages/daemon"), "../../../../outside", "missing"]:
            with self.subTest(target=target):
                link.symlink_to(target)
                with self.assertRaises((ValueError, FileNotFoundError)):
                    validate_symlinks(runtime)
                link.unlink()

    def test_runtime_prebuilds_are_arm64_and_helper_executable(self):
        runtime = self.runtime()
        prebuilds = runtime / "node_modules/node-pty/prebuilds"
        for platform in ["darwin-arm64", "darwin-x64", "win32-arm64", "linux-arm64"]:
            (prebuilds / platform).mkdir(parents=True)
            (prebuilds / platform / "spawn-helper").write_text("binary")
            (prebuilds / platform / "LICENSE").write_text("license")
        prepare_runtime(runtime)
        self.assertEqual([p.name for p in prebuilds.iterdir()], ["darwin-arm64"])
        self.assertEqual((prebuilds / "darwin-arm64/spawn-helper").stat().st_mode & 0o777, 0o755)
        self.assertTrue((prebuilds / "darwin-arm64/LICENSE").is_file())

    def test_latest_version_never_regresses_after_old_run_rerun(self):
        self.assertFalse(newer_than_latest("10.2", "pilot-11.1"))
        self.assertFalse(newer_than_latest("11.1", "pilot-11.1"))
        self.assertTrue(newer_than_latest("11.2", "pilot-11.1"))
        self.assertTrue(newer_than_latest("12.1", "pilot-11.99"))
        self.assertTrue(newer_than_latest("100.1", "pilot-99.9"))
        self.assertTrue(newer_than_latest("1.1", ""))
        with self.assertRaises(ValueError):
            newer_than_latest("12.1", "other-release")


if __name__ == "__main__":
    unittest.main()
