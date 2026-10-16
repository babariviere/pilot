import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[2] / "apps/macos/Sources/PilotCore/Resources/LinuxSSHBootstrap.py"
spec = importlib.util.spec_from_file_location("ssh_bootstrap", HELPER)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def archive(extra=()):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w:gz") as output:
        for name in ["node/bin/node", "service.mjs", "packages/daemon/src/linux-coordinator-probe.ts"]:
            item = tarfile.TarInfo("runtime/" + name)
            item.size = 4
            output.addfile(item, io.BytesIO(b"file"))
        for item, contents in extra:
            output.addfile(item, io.BytesIO(contents))
    return result.getvalue()


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.good = archive()
        self.sha = hashlib.sha256(self.good).hexdigest()

    def stage(self, data=None, digest=None):
        return bootstrap.stage(self.base, digest or self.sha, len(self.good), io.BytesIO(self.good if data is None else data))

    def test_repeat_and_lost_reply_preserve_runtime_and_data(self):
        root = self.stage()
        (root / "coordinator-preflight.json").write_text("preserve")
        self.assertEqual(self.stage(), root)
        self.assertEqual((root / "coordinator-preflight.json").read_text(), "preserve")
        self.assertEqual(list(self.base.glob(".stage-*")), [])

    def test_partial_and_corrupt_upload_never_publish(self):
        for data in [self.good[:20], b"x" * len(self.good), self.good + b"extra"]:
            with self.subTest(length=len(data)), self.assertRaises(bootstrap.Blocked):
                self.stage(data)
            self.assertFalse((self.base / self.sha).exists())
        self.stage()
        with self.assertRaises(bootstrap.Blocked):
            self.stage(b"x" * len(self.good))

    def test_existing_uncommitted_or_symlink_runtime_is_not_replaced(self):
        final = self.base / self.sha
        final.symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(bootstrap.Blocked):
            self.stage()
        final.unlink()
        final.mkdir()
        (final / "complete").write_text("foreign")
        with self.assertRaises(bootstrap.Blocked):
            self.stage()
        self.assertEqual((final / "complete").read_text(), "foreign")

    def test_archive_rejects_traversal_devices_privilege_links_duplicates_and_chains(self):
        for name, kind, target, mode in [
            ("../escape", tarfile.REGTYPE, "", 0o600),
            ("/absolute", tarfile.REGTYPE, "", 0o600),
            ("runtime/device", tarfile.CHRTYPE, "", 0o600),
            ("runtime/setuid", tarfile.REGTYPE, "", 0o4755),
            ("runtime/link", tarfile.SYMTYPE, "/etc/passwd", 0o700),
            ("runtime/link", tarfile.SYMTYPE, "../../outside", 0o700),
            ("runtime/link", tarfile.LNKTYPE, "../outside", 0o700),
            ("runtime/node/bin/node", tarfile.REGTYPE, "", 0o600),
        ]:
            item = tarfile.TarInfo(name)
            item.type, item.linkname, item.mode = kind, target, mode
            with self.subTest(name=name, kind=kind):
                self.reject_archive(archive([(item, b"")]))
        link = tarfile.TarInfo("runtime/link")
        link.type, link.linkname = tarfile.SYMTYPE, "node"
        child = tarfile.TarInfo("runtime/link/child")
        self.reject_archive(archive([(link, b""), (child, b"")]))

    def reject_archive(self, data):
        path = self.base / "archive"
        path.write_bytes(data)
        dest = self.base / "unpack"
        dest.mkdir(exist_ok=True)
        with self.assertRaises(bootstrap.Blocked):
            bootstrap.extract(path, dest)

    def test_safe_relative_symlinks_and_regular_hardlinks(self):
        link = tarfile.TarInfo("runtime/node-link")
        link.type, link.linkname = tarfile.SYMTYPE, "node/bin/node"
        hard = tarfile.TarInfo("runtime/hard-link")
        hard.type, hard.linkname = tarfile.LNKTYPE, "runtime/node/bin/node"
        data = archive([(link, b""), (hard, b"")])
        root = bootstrap.stage(self.base, hashlib.sha256(data).hexdigest(), len(data), io.BytesIO(data))
        self.assertEqual((root / "node-link").read_bytes(), b"file")
        self.assertEqual((root / "hard-link").read_bytes(), b"file")

    def test_ancestor_symlink_and_public_runtime_directory_fail(self):
        (self.base / "link").symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(bootstrap.Blocked):
            bootstrap.private_directory(self.base / "link/runtime")
        public = self.base / "public"
        public.mkdir(mode=0o755)
        with self.assertRaises(bootstrap.Blocked):
            bootstrap.private_directory(public)

    def test_missing_linger_returns_explicit_dnf_plan_without_install(self):
        report = dict(ok=False, requirements=[dict(id="linger", ok=False)],
                      packagePlan=dict(manager="dnf", command=["sudo", "dnf", "install", "-y", "git"]),
                      lingerSetup=dict(requiresPrivilege=True, command=["sudo", "loginctl", "enable-linger", "fixture"]))
        with patch.object(bootstrap.subprocess, "run", return_value=SimpleNamespace(returncode=2, stdout=json.dumps(report))) as run:
            with self.assertRaises(bootstrap.Blocked) as error:
                bootstrap.activate(self.base, self.base)
        self.assertEqual(error.exception.result["plan"], report)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][-1], "probe")

    def test_service_readiness_does_not_imply_sandbox_and_never_restarts(self):
        report = dict(ok=True, packagePlan=dict(manager="dnf"))
        identity = dict(daemonId="id", lineageId="lineage")
        for available in [False, True]:
            (self.base / "coordinator-preflight.json").write_text(json.dumps(dict(available=available)))
            calls = []
            def command(args, *_):
                calls.append(args)
                if args[-1] == "status":
                    return json.dumps(dict(ActiveState="active", MainPID="123"))
                return "enabled\n" if "is-enabled" in args else ""
            with patch.object(bootstrap.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(report))), \
                    patch.object(bootstrap, "command", command), patch.object(bootstrap, "read_identity", return_value=identity):
                if available:
                    self.assertTrue(bootstrap.activate(self.base, self.base)["ok"])
                else:
                    with self.assertRaises(bootstrap.Blocked) as error:
                        bootstrap.activate(self.base, self.base)
                    self.assertEqual(error.exception.result["code"], "sandbox")
                    self.assertEqual(error.exception.result["plan"]["command"], ["sudo", "dnf", "install", "-y", "bubblewrap"])
            self.assertFalse(any("restart" in call or "stop" in call or "sudo" in call for call in calls))

    def test_pinned_identity_mismatch_blocks_before_staging(self):
        with patch.object(bootstrap.platform, "system", return_value="Linux"), \
                patch.object(bootstrap.platform, "machine", return_value="x86_64"), \
                patch.object(bootstrap.os, "getuid", return_value=1000), \
                patch.object(bootstrap, "read_identity", return_value=None), \
                patch.object(bootstrap, "stage") as stage:
            with self.assertRaises(bootstrap.Blocked) as error:
                bootstrap.setup(self.sha, len(self.good), dict(daemonId="old", lineageId="old"), io.BytesIO(self.good))
            self.assertEqual(error.exception.result["code"], "identity")
            stage.assert_not_called()

    def test_busy_setup_and_lost_process_scratch_reconciliation_preserve_data(self):
        home = self.base / "home"
        base = home / ".local/share/pilot/runtimes"
        base.mkdir(parents=True, mode=0o700)
        stale = base / ".stage-abandoned"
        stale.mkdir()
        (stale / ".bootstrap-stage").write_text("pilot-bootstrap-v1")
        (stale / "partial.tgz").write_bytes(b"partial")
        unrelated = base / ".stage-unmarked"
        unrelated.mkdir()
        credential = home / ".local/share/pilot/auth.json"
        credential.write_text("fixture-secret-never-transferred")
        with patch.object(bootstrap.Path, "home", return_value=home), \
                patch.object(bootstrap.platform, "system", return_value="Linux"), \
                patch.object(bootstrap.platform, "machine", return_value="x86_64"), \
                patch.object(bootstrap, "activate", return_value=dict(ok=True)):
            with (base / ".bootstrap.lock").open("w") as lock:
                bootstrap.fcntl.flock(lock, bootstrap.fcntl.LOCK_EX)
                with self.assertRaises(bootstrap.Blocked) as error:
                    bootstrap.setup(self.sha, len(self.good), None, io.BytesIO(self.good))
                self.assertEqual(error.exception.result["code"], "busy")
                self.assertTrue(stale.exists())
            self.assertTrue(bootstrap.setup(self.sha, len(self.good), None, io.BytesIO(self.good))["ok"])
        self.assertFalse(stale.exists())
        self.assertTrue(unrelated.exists())
        self.assertEqual(credential.read_text(), "fixture-secret-never-transferred")


if __name__ == "__main__":
    unittest.main()
