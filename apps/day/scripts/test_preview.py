"""Portable preview installer tests. Fake bundles are never run or trusted."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("preview", Path(__file__).with_name("preview.py"))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)
REAL_RUN = preview.run

DENIED = dict(network=dict(hosts=[], http=[]),
              process=dict(execute=[], exit=False, env=[]), fs=dict(read=[], write=[]),
              statusBar=False, clipboard=False, picker=False, openUrl=False)


class PreviewInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="preview-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.first = "1" * 40
        self.next = "2" * 40
        self.bundle(self.first)
        self.bundle(self.next)
        self.run = patch.object(preview, "run")
        self.fake_run = self.run.start()
        self.fake_run.return_value.stdout = ""
        self.addCleanup(self.run.stop)

    def bundle(self, source):
        app = self.home / "versions" / source / preview.APP
        macos = app / "Contents/MacOS"
        resources = app / "Contents/Resources/nsh"
        macos.mkdir(parents=True)
        resources.mkdir(parents=True)
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps(dict(
            CFBundleIdentifier=preview.IDENTITY, CFBundleExecutable="PilotPreview")))
        (macos / "PilotPreview").write_text("fake executable, never run")
        (macos / "PilotPreview").chmod(0o755)
        (resources / "bundle.nshc").write_bytes(b"fake, never loaded")
        (resources / "app.json").write_text(json.dumps(dict(id=preview.IDENTITY, name="Pilot Preview")))
        (resources / "capabilities.json").write_text(json.dumps(DENIED))
        return app

    def pending(self, source):
        (self.home / "pending.json").write_text(json.dumps(dict(source=source)))

    def install_first(self):
        self.pending(self.first)
        self.assertTrue(preview.activate(self.home))

    def test_closed_refresh_keeps_old_version_and_draft_bytes(self):
        self.install_first()
        drafts = self.home / "separate-demo-storage.json"
        drafts.write_text('日本語, exact unsent text\n')
        self.pending(self.next)
        self.assertTrue(preview.activate(self.home))
        self.assertEqual((self.home / "current").resolve().name, self.next)
        self.assertTrue((self.home / "versions" / self.first / preview.APP).exists())
        self.assertEqual(drafts.read_text(), '日本語, exact unsent text\n')

    def test_running_preview_stages_without_switch_or_quit(self):
        self.install_first()
        self.pending(self.next)
        self.fake_run.return_value.stdout = str(preview.executable(self.home / "versions" / self.first / preview.APP))
        self.assertFalse(preview.activate(self.home))
        self.assertEqual((self.home / "current").resolve().name, self.first)
        self.assertFalse(any("kill" in str(c) or "open" in str(c) for c in self.fake_run.call_args_list))

    def test_failed_refresh_keeps_current(self):
        self.install_first()
        self.pending(self.next)
        (self.home / "versions" / self.next / preview.APP / "Contents/Resources/nsh/bundle.nshc").unlink()
        with self.assertRaises(ValueError):
            preview.activate(self.home)
        self.assertEqual((self.home / "current").resolve().name, self.first)

    def test_failed_signature_and_process_inventory_refuse_switch(self):
        self.install_first()
        self.pending(self.next)
        for failing in ("/usr/bin/codesign", "/bin/ps"):
            def run(args, **_kwargs):
                if args[0] == failing:
                    raise OSError("not available")
                return type("Result", (), dict(stdout=""))()
            with patch.object(preview, "run", side_effect=run), self.assertRaises(OSError):
                preview.activate(self.home)
            self.assertEqual((self.home / "current").resolve().name, self.first)

    def test_foreign_bundle_or_host_grant_refused(self):
        app = self.home / "versions" / self.next / preview.APP
        grants = app / "Contents/Resources/nsh/capabilities.json"
        grants.write_text(json.dumps(dict(DENIED, host=["bridge.*"])))
        with self.assertRaises(ValueError):
            preview.validate(app)
        grants.write_text(json.dumps(DENIED))
        info = app / "Contents/Info.plist"
        info.write_bytes(plistlib.dumps(dict(CFBundleIdentifier="dev.pilot.day", CFBundleExecutable="PilotPreview")))
        with self.assertRaises(ValueError):
            preview.validate(app)

    def test_launcher_is_user_launchable_and_does_not_replace_pilot(self):
        applications = self.home / "Applications"
        applications.mkdir()
        pilot = applications / "Pilot.app"
        pilot.write_text("untouched")
        launcher = preview.install_launcher(self.home, applications)
        self.assertTrue(os.access(launcher, os.X_OK))
        self.assertIn(" launch", launcher.read_text())
        self.assertEqual(pilot.read_text(), "untouched")
        launcher.write_text("someone else's launcher")
        with self.assertRaises(ValueError):
            preview.install_launcher(self.home, applications)

    def test_bad_source_cannot_escape_version_directory(self):
        self.pending("../foreign")
        with self.assertRaises(ValueError):
            preview.activate(self.home)

    @unittest.skipUnless(Path("/bin/sleep").exists(), "needs a local non-GUI process")
    def test_real_process_inventory_detects_a_versioned_executable(self):
        binary = self.home / "versions" / "process-probe"
        shutil.copyfile("/bin/sleep", binary)
        binary.chmod(0o755)
        if sys.platform == "darwin":
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(binary)],
                           check=True, capture_output=True)
        process = subprocess.Popen([str(binary), "30"])
        try:
            with patch.object(preview, "run", REAL_RUN):
                self.assertTrue(preview.running(self.home))
        finally:
            process.terminate()
            process.wait(timeout=5)
        with patch.object(preview, "run", REAL_RUN):
            self.assertFalse(preview.running(self.home))


if __name__ == "__main__":
    unittest.main()
