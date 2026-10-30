"""Synthetic release-policy/ZIP/workflow checks. No native qualification claim."""
import base64
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import bundle_runtime as bundle
import gui_release as release


class GuiReleaseTests(unittest.TestCase):
    def test_macos_assembly_needs_no_prior_capsules_or_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "release"
            def snapshot(source, destination, **kwargs):
                destination.mkdir()
                bundle.write_json(destination / "runtime-build.json", {"protocol": 7})
            def assemble(runtime, rust, native, app, source, **kwargs):
                app.mkdir()
            config = {"build": "200.1", "code_requirement": 'identifier "synthetic"'}
            with patch.object(bundle, "snapshot_build", side_effect=snapshot), \
                    patch.object(bundle, "snapshot_rust", side_effect=snapshot), \
                    patch.object(bundle, "assemble", side_effect=assemble) as assembly, \
                    patch.object(bundle, "verify"), patch.object(bundle, "native_closure"), \
                    patch.object(release.subprocess, "run"), patch.object(release, "artifact"), \
                    patch("macos_release_capsules.previous_macos_capsules", side_effect=AssertionError("must not discover old releases")) as discover:
                release.macos("a" * 40, output, config)
            discover.assert_not_called()
            self.assertNotIn("accepted_capsules", assembly.call_args.kwargs)

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

    def test_linux_release_admits_newest_published_linux_runtimes(self):
        import hashlib, io, json
        def archive(inventory):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as package:
                package.writestr("Pilot Next/linux-gui-package.json", inventory)
            return buffer.getvalue()
        linux = lambda tag: {"name": release.LINUX_ARCHIVE, "browser_download_url": f"https://github.com/o/r/releases/download/{tag}/x.zip"}
        listing = [
            {"tag_name": "v9", "draft": True, "assets": [linux("v9")]},
            {"tag_name": "v8", "assets": [linux("v8")]},
            {"tag_name": "v7", "assets": [{"name": "Pilot-arm64.zip"}]},
            {"tag_name": "v6", "prerelease": True, "assets": [linux("v6")]},
            {"tag_name": "v5", "assets": [linux("v5")]},
            {"tag_name": "v4", "assets": [linux("v4")]},
        ]
        seen = []
        class Response(io.BytesIO):
            pass
        def opener(request, timeout):
            seen.append((request.full_url, request.get_header("Authorization")))
            if "api.github.com" in request.full_url:
                return Response(json.dumps(listing).encode())
            return Response(archive(request.full_url.split("/")[-2].encode()))
        digests = release.previous_linux_capsules("o/r", "token", limit=2, opener=opener)
        self.assertEqual(digests, [hashlib.sha256(b"v8").hexdigest(), hashlib.sha256(b"v5").hexdigest()])
        self.assertEqual(seen[0], ("https://api.github.com/repos/o/r/releases?per_page=30", "Bearer token"))
        self.assertTrue(all(auth is None for _, auth in seen[1:]))
        configured = "a" * 64
        env = {"PILOT_NEXT_ACCEPTED_CAPSULES": json.dumps([configured])}
        previous = [configured, "b" * 64, "c" * 64, "d" * 64, "e" * 64]
        self.assertEqual(release.linux_release_capsules(env, previous), [configured, "b" * 64, "c" * 64, "d" * 64])

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

    def test_workflow_builds_and_finalizes_only_real_gui(self):
        root = bundle.ROOT
        workflow = (root / ".github/workflows/release.yaml").read_text()
        package = (root / ".github/workflows/gui-package.yml").read_text()
        self.assertNotIn("release/Pilot-linux-x64", workflow)
        self.assertNotIn("LINUX_RUNTIME_PRIVATE_KEY", workflow)
        for name in ("macos-gui:", "linux-gui:", "gui-publish:"):
            self.assertIn(name, workflow)
        self.assertIn("needs: [target, gui-publish]", workflow)
        self.assertNotIn("macos-app:", workflow)
        self.assertNotIn("macos-publish:", workflow)
        self.assertIn("bundle_runtime", (root / "apps/desktop/scripts/gui_release.py").read_text())
        self.assertIn("--release --locked --workspace --bins", package)
        self.assertIn("--platform macos", package)
        self.assertIn("linux_gui_package_runtime.py", package)
        self.assertIn("seal-linux", package)
        self.assertNotIn("publish-release.sh", package)
        # Retried drafts keep tagged app source but run current packaging helpers.
        self.assertIn("ref: ${{ github.sha }}", package)
        for helper in ("gui_release.py", "bundle_runtime.py", "macos_release_capsules.py", "linux_gui_package_runtime.py"):
            self.assertTrue((root / "apps/desktop/scripts" / helper).is_file())
            self.assertIn(helper, package.split("Apply current packaging helpers")[1].split("- uses:")[0])
        macos_step = package.split("Build optimized macOS GUI, updater helper and immutable native/runtime closure")[1].split("- name:")[0]
        self.assertIn("GH_TOKEN: ${{ github.token }}", macos_step)


if __name__ == "__main__":
    unittest.main()
