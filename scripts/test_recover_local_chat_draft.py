import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("repair", Path(__file__).with_name("recover-local-chat-draft.py"))
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class LocalDraftRepairTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ("Drafts", "Operations", "Attachments"):
            (self.root / name).mkdir(mode=0o700)
        self.local = dict(hostId="local", daemonId="mac", lineageId="mac-history")
        self.remote = dict(hostId="box", daemonId="remote", lineageId="remote-history")
        image = self.root / "Attachments/newer.png"
        image.write_bytes(b"unchanged image bytes")
        payload = json.dumps(dict(message="original remote input", cwd="/remote"))
        self.operation = dict(schemaVersion=1, operationId="original", targetId="UPPERCASE-TARGET", origin=self.local,
                              destination=self.remote, kind="chat-create", payload=payload,
                              payloadHash=hashlib.sha256(payload.encode()).hexdigest())
        self.drafts = dict(version=1, localHost=self.local, selection=dict(kind="session", localId="old-selection", host=self.local),
                           chats={"other": dict(text="other draft", attachments=[])}, adoptedOperations=["previous"],
                           newTask=dict(executionHost=self.remote, pendingOperationId="original", message="newer draft",
                                        attachments=[dict(id="image", url=image.as_uri(), submitted=False)],
                                        projectId="remote-project", folder="/remote", model="remote/model", mode="ask",
                                        workspace="direct", branchScope="remote", baseBranch="branch", pendingMessage="remote prefill",
                                        pendingBaseBranch="remote branch", pendingCwd="/remote", pendingWorkspace="clone",
                                        mission={"id": "remote-mission"}, trackedItem={"id": "remote-ticket"}, runningTab=True))
        self.source = self.root / "Drafts/drafts.json"
        self.outbox = self.root / "Operations/original.json"
        self.write(self.source, self.drafts)
        self.write(self.outbox, self.operation)

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def test_only_detaches_remote_context_and_preserves_original_bytes(self):
        before = self.source.read_bytes()
        outbox = self.outbox.read_bytes()
        backup = repair.repair(self.root, running=lambda: False)
        result = json.loads(self.source.read_bytes())
        self.assertEqual(backup.read_bytes(), before)
        self.assertEqual(os.stat(backup).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.source).st_mode & 0o777, 0o600)
        self.assertEqual(self.outbox.read_bytes(), outbox)
        self.assertEqual({k: v for k, v in result.items() if k != "newTask"}, {k: v for k, v in self.drafts.items() if k != "newTask"})
        task = result["newTask"]
        for name in ("message", "attachments", "mode"):
            self.assertEqual(task[name], self.drafts["newTask"][name])
        self.assertEqual(task["executionHost"], self.local)
        self.assertIsNone(task["pendingOperationId"])
        self.assertIsNone(task["projectId"])
        self.assertEqual(task["folder"], "")
        self.assertIsNone(task["mission"])
        self.assertIsNone(task["pendingMessage"])
        self.assertTrue((self.root / "Attachments/newer.png").exists())
        # The installed host-scoped fallback finds no remote intent for Local, but still finds it for box.
        self.assertNotEqual(self.operation["destination"], task["executionHost"])
        self.assertEqual(self.operation["destination"], self.remote)
        with self.assertRaises(RuntimeError):
            repair.repair(self.root, running=lambda: False)

    def test_running_app_or_relaunch_during_repair_never_replaces_original(self):
        before = self.source.read_bytes()
        with self.assertRaises(RuntimeError):
            repair.repair(self.root, running=lambda: True)
        self.assertEqual(before, self.source.read_bytes())
        checks = iter([False, True])
        with self.assertRaises(RuntimeError):
            repair.repair(self.root, running=lambda: next(checks))
        self.assertEqual(before, self.source.read_bytes())

    def test_bad_pin_hash_format_and_missing_operation_fail_closed(self):
        for mutation in (lambda d, o: d.update(version=2), lambda d, o: d.update(localHost=None),
                         lambda d, o: d.update(parkedNewTasks=[{"executionHost": self.local}]),
                         lambda d, o: o.update(payloadHash="wrong"), lambda d, o: o.update(destination=self.local),
                         lambda d, o: o.update(operationId="other")):
            with self.subTest(mutation=mutation):
                d, o = copy.deepcopy(self.drafts), copy.deepcopy(self.operation)
                mutation(d, o)
                self.write(self.source, d)
                self.write(self.outbox, o)
                before = self.source.read_bytes()
                with self.assertRaises(RuntimeError):
                    repair.repair(self.root, running=lambda: False)
                self.assertEqual(before, self.source.read_bytes())

    def test_symlink_draft_is_not_followed(self):
        other = self.root / "original-private.json"
        self.source.rename(other)
        self.source.symlink_to(other)
        before = other.read_bytes()
        with self.assertRaises(OSError):
            repair.repair(self.root, running=lambda: False)
        self.assertEqual(before, other.read_bytes())


if __name__ == "__main__":
    unittest.main()
