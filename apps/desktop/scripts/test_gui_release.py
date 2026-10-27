"""Synthetic release-policy/ZIP/workflow checks. No native qualification claim."""
import base64
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import bundle_runtime as bundle
import gui_release as release


class GuiReleaseTests(unittest.TestCase):
    def test_release_trust_is_explicit_and_separate_from_swift(self):
        env = dict(PILOT_NEXT_SIGNING_POLICY="private-adhoc", PILOT_NEXT_UPDATER_PUBLIC_KEY=base64.b64encode(bytes(32)).decode(),
                   PILOT_NEXT_UPDATER_REPOSITORY="owner/repo", PILOT_NEXT_UPDATER_BUILD="200.1")
        config = release.configuration(env)
        self.assertEqual(config["application_id"], bundle.APP_ID)
        self.assertEqual(config["code_requirement"], 'identifier "com.babariviere.pilot-next"')
        for name in env:
            with self.subTest(name=name), self.assertRaises(ValueError):
                release.configuration({k: v for k, v in env.items() if k != name})
        with self.assertRaises(ValueError):
            release.configuration(env | dict(PILOT_NEXT_SIGNING_POLICY="developer-id"))
        for bad in ("", "01", "1.000", "1.2.3.4.5"):
            with self.subTest(build=bad), self.assertRaises(ValueError):
                release.configuration(env | dict(PILOT_NEXT_UPDATER_BUILD=bad))

    def test_retained_capsule_policy_preserves_exact_existing_allowlist_contract(self):
        self.assertEqual(release.accepted_capsules({}), [])
        self.assertEqual(release.accepted_capsules({"PILOT_NEXT_ACCEPTED_CAPSULES": '["' + "a" * 64 + '"]'}), ["a" * 64])
        for value in ('"all"', '["1.2.3"]', '["' + "a" * 64 + '","' + "a" * 64 + '"]'):
            with self.assertRaises(ValueError):
                release.accepted_capsules({"PILOT_NEXT_ACCEPTED_CAPSULES": value})

    def test_current_linux_candidate_cannot_be_archived_as_a_usable_release(self):
        import linux_gui_package as linux
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package = root / "Pilot Next"
            package.mkdir()
            bundle.write_json(package / linux.MANIFEST, dict(bundled_launch=False, updater=False, installer=False))
            with patch.object(linux, "verify"), self.assertRaisesRegex(ValueError, "bundled_launch"):
                release.linux_archive("a" * 40, package, root / "output", "200.1")
            self.assertFalse((root / "output").exists())

    def test_zip_preserves_relative_links_modes_and_exact_root(self):
        import linux_gui_package as linux
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package = root / "Pilot Next"
            package.mkdir()
            (package / "bin").mkdir()
            binary = package / "bin/pilot-next"
            binary.write_text("faux, never run")
            binary.chmod(0o755)
            (package / "relative").symlink_to("bin/pilot-next")
            bundle.write_json(package / linux.MANIFEST, dict(source="a" * 40, bundled_launch=True,
                              updater=True, installer=True, native_visual_execution=False))
            (package / "linux-gui-package.sig").write_text(base64.b64encode(bytes(64)).decode())
            with patch.object(linux, "verify"), patch.object(linux, "elf_closure", return_value=[]):
                release.linux_archive("a" * 40, package, root / "output", "200.1")
            with zipfile.ZipFile(root / "output" / release.LINUX_ARCHIVE) as archive:
                self.assertTrue(all(name.startswith("Pilot Next/") for name in archive.namelist()))
                link = archive.getinfo("Pilot Next/relative")
                self.assertTrue(stat.S_ISLNK(link.external_attr >> 16))
                self.assertEqual(archive.read(link), b"bin/pilot-next")
                self.assertEqual(archive.getinfo("Pilot Next/bin/pilot-next").external_attr >> 16 & 0o777, 0o755)

    def test_workflow_builds_real_gui_and_only_finalizes_gui_plus_preserved_swift(self):
        root = bundle.ROOT
        workflow = (root / ".github/workflows/release.yaml").read_text()
        package = (root / ".github/workflows/gui-package.yml").read_text()
        self.assertNotIn("release/Pilot-linux-x64", workflow)
        self.assertNotIn("LINUX_RUNTIME_PRIVATE_KEY", workflow)
        for name in ("macos-gui:", "linux-gui:", "gui-publish:", "macos-publish:"):
            self.assertIn(name, workflow)
        self.assertIn("needs: [target, gui-publish, macos-publish]", workflow)
        self.assertIn("bundle_runtime", (root / "apps/desktop/scripts/gui_release.py").read_text())
        self.assertIn("--release --locked --workspace --bins", package)
        self.assertIn("--platform macos", package)
        self.assertIn("linux_gui_package_runtime.py", package)
        self.assertIn("seal-linux", package)
        self.assertNotIn("publish-release.sh", package)
        # Retried drafts keep tagged app source but run current packaging helpers.
        self.assertIn("ref: ${{ github.sha }}", package)
        for helper in ("gui_release.py", "bundle_runtime.py", "linux_gui_package_runtime.py"):
            self.assertTrue((root / "apps/desktop/scripts" / helper).is_file())
            self.assertIn(helper, package.split("Apply current packaging helpers")[1].split("- uses:")[0])


if __name__ == "__main__":
    unittest.main()
