import base64
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.dont_write_bytecode = True
from release_metadata import (
    SPARKLE, appcast, dmg_release_tag, newer_build_than_latest, newer_than_latest, prepare_runtime,
    release_state, stable_version, validate_symlinks, write_plist,
)


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

    def test_bundle_uses_package_version_without_changing_sparkle_build_version(self):
        write_plist(self.source, self.output, "/checkout", True, self.env, app_version="1.2.3")
        info = plistlib.loads(self.output.read_bytes())
        self.assertEqual(info["CFBundleShortVersionString"], "1.2.3")
        self.assertEqual(info["CFBundleVersion"], "12345.2")

    def test_plist_cli_reads_package_version(self):
        (self.root / "package.json").write_text('{"version":"2.3.4"}')
        result = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve().parents[1] / "release_metadata.py"),
                                 "plist", str(self.source), str(self.output), str(self.root)],
                                env={}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(plistlib.loads(self.output.read_bytes())["CFBundleShortVersionString"], "2.3.4")

    def test_rejects_non_stable_app_versions(self):
        for value in ["1", "1.2", "01.2.3", "1.2.3-beta.1", "1.2.3+build", "v1.2.3", "1.2.3\n"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                stable_version(value)
        self.assertEqual(stable_version("0.1.0"), "0.1.0")

    def test_dev_release_versions_are_rejected(self):
        for kind in ['dev', 'unknown']:
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                write_plist(self.source, self.output, "/checkout", True,
                            {**self.env, "RELEASE_KIND": kind}, app_version="0.2.0")

    def test_only_matching_drafts_can_be_modified(self):
        draft = {"isDraft": True, "isPrerelease": False, "assets": []}
        self.assertEqual(release_state(draft), "draft")
        for release in [{**draft, "isPrerelease": True}, {**draft, "isDraft": False},
                        {**draft, "isDraft": False, "isPrerelease": True}]:
            with self.subTest(release=release), self.assertRaises(ValueError):
                release_state(release)

    def test_dmg_requires_a_complete_published_stable_release_without_an_installer(self):
        release = {"tagName": "v1.2.3", "isDraft": False, "isPrerelease": False, "assets": [
            {"name": name, "state": "uploaded"} for name in ['Pilot-arm64.zip', 'appcast.xml']
        ]}
        self.assertEqual(dmg_release_tag(release), "v1.2.3")
        for changes in [{"isDraft": True}, {"isPrerelease": True}, {"tagName": "dev-123"},
                        {"tagName": "v1.2.3-beta.1"}, {"tagName": "v1.2.3\n"}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                dmg_release_tag({**release, **changes})
        for i in range(len(release['assets'])):
            with self.subTest(asset=i), self.assertRaises(ValueError):
                dmg_release_tag({**release, "assets": [a for j, a in enumerate(release['assets']) if i != j]})
        with self.assertRaises(ValueError):
            dmg_release_tag({**release, "assets": [{**a, "state": "new"} for a in release['assets']]})
        for state in ['uploaded', 'new']:
            with self.subTest(state=state), self.assertRaises(ValueError):
                dmg_release_tag({**release, "assets": release['assets'] + [
                    {"name": "Pilot-arm64.dmg", "state": state}]})

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

    def test_runtime_removes_maps_and_declarations_but_retains_code_and_resources(self):
        runtime = self.runtime()
        dependency = runtime / "node_modules/example"
        dependency.mkdir()
        removed = ["index.js.map", "index.mjs.map", "index.d.ts", "index.d.ts.map", "index.d.mts", "index.d.cts"]
        retained = ["index.js", "index.mjs", "index.cjs", "source.ts", "source.mts", "source.cts",
                    "README.md", "LICENSE", "package.json", "theme.json", "font.woff2", "native.node"]
        for name in removed + retained:
            (dependency / name).write_text("fixture")
        nested = dependency / "node_modules/nested/dist"
        nested.mkdir(parents=True)
        (nested / "bundle.js.map").write_text("map")
        (nested / "bundle.js").write_text("code")
        workspace = runtime / "packages/daemon"
        (workspace / "main.ts").write_text("source")
        link = runtime / "node_modules/@pilot/daemon"
        link.symlink_to("../../packages/daemon")
        prepare_runtime(runtime)
        self.assertTrue(all(not (dependency / name).exists() for name in removed))
        self.assertTrue(all((dependency / name).read_text() == "fixture" for name in retained))
        self.assertFalse((nested / "bundle.js.map").exists())
        self.assertEqual((nested / "bundle.js").read_text(), "code")
        self.assertEqual((link / "main.ts").read_text(), "source")
        self.assertTrue(link.is_symlink())
        validate_symlinks(runtime)
        prepare_runtime(runtime)  # Repeated preparation is harmless.
        validate_symlinks(runtime)

    def test_runtime_cleanup_does_not_follow_symlinks(self):
        runtime = self.runtime()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "external.js.map").write_text("untouched")
        (runtime / "node_modules/external").symlink_to(outside, target_is_directory=True)
        # Preserve file links too, even if their names match a removable suffix.
        link = runtime / "node_modules/alias.d.ts"
        link.symlink_to("../packages/daemon/package.json")
        prepare_runtime(runtime)
        self.assertEqual((outside / "external.js.map").read_text(), "untouched")
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.read_text(), '{}')

    def test_runtime_cleanup_preserves_special_files(self):
        runtime = self.runtime()
        pipe = runtime / "node_modules/stream.js.map"
        os.mkfifo(pipe)
        prepare_runtime(runtime)
        self.assertTrue(stat.S_ISFIFO(pipe.lstat().st_mode))

    def test_latest_stable_version_never_regresses_after_old_run_rerun(self):
        self.assertFalse(newer_than_latest("0.2.0", "v0.3.0"))
        self.assertFalse(newer_than_latest("0.3.0", "v0.3.0"))
        self.assertTrue(newer_than_latest("0.3.1", "v0.3.0"))
        self.assertTrue(newer_than_latest("1.0.0", "v0.99.99"))
        self.assertTrue(newer_than_latest("1.10.0", "v1.9.9"))
        self.assertTrue(newer_than_latest("0.2.0", ""))
        for latest in ["other-release", "v1.2.3-beta.1", "pilot-bad"]:
            with self.subTest(latest=latest), self.assertRaises(ValueError):
                newer_than_latest("1.2.3", latest)

    def test_stable_release_can_replace_legacy_build_release(self):
        self.assertTrue(newer_than_latest("0.2.0", "pilot-123.1"))

    def test_delayed_stable_release_cannot_regress_sparkle_build_version(self):
        feed = self.root / "appcast.xml"
        feed.write_bytes(appcast("owner/repo", "123", "10.2", "0.2.0", base64.b64encode(bytes(64)).decode(), 1))
        self.assertFalse(newer_build_than_latest("9.1", feed))
        self.assertFalse(newer_build_than_latest("10.2", feed))
        self.assertTrue(newer_build_than_latest("10.3", feed))
        self.assertTrue(newer_build_than_latest("11.1", feed))
        feed.write_text('<rss><channel><item /></channel></rss>')
        with self.assertRaises(ValueError):
            newer_build_than_latest("11.1", feed)


if __name__ == "__main__":
    unittest.main()
