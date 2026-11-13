import base64
import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "signing", Path(__file__).with_name("provision-signing.py")
)
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class SigningTest(unittest.TestCase):
    def test_matching_ed25519_only(self):
        public = bytes(range(32))
        der = bytes.fromhex("302a300506032b6570032100") + public
        with patch.object(signing, "run", return_value=der) as run:
            signing.verify_key(b"fixture-not-a-secret", base64.b64encode(public))
            self.assertEqual(run.call_args.kwargs["data"], b"fixture-not-a-secret")
        with (
            patch.object(signing, "run", return_value=b"wrong"),
            self.assertRaises(ValueError),
        ):
            signing.verify_key(b"fixture", base64.b64encode(public))

    def test_missing_public_key_refuses_before_process(self):
        with patch.object(signing, "run") as run:
            with self.assertRaises(ValueError):
                signing.verify_key(b"fixture", b"")
            run.assert_not_called()

    def test_process_error_never_includes_child_output(self):
        result = subprocess.CompletedProcess(
            [], 1, b"sensitive-stdout", b"sensitive-stderr"
        )
        with (
            patch.object(subprocess, "run", return_value=result),
            self.assertRaisesRegex(ValueError, "^Failed operation: openssl$"),
        ):
            signing.run(["openssl"], data=b"sensitive-stdin")

    def test_explicit_write_required(self):
        with patch.object(sys, "argv", ["script"]), patch.object(signing, "run") as run:
            with self.assertRaises(ValueError):
                signing.main()
            run.assert_not_called()

    def test_missing_ciphertext_never_writes(self):
        repo = b'{"nameWithOwner":"babariviere/pilot","viewerPermission":"ADMIN"}'
        missing = '[secrets.DAY_UPDATER_PRIVATE_KEY]\nprovider = "age"\n'
        with (
            patch.object(sys, "argv", ["script", "--write"]),
            patch.object(signing, "run", return_value=repo) as run,
            patch.object(Path, "read_text", return_value=missing),
        ):
            with self.assertRaisesRegex(ValueError, "Import the verified existing key"):
                signing.main()
            self.assertEqual(run.call_count, 1)

    def test_write_timeout_is_unknown_without_retry(self):
        repo = b'{"nameWithOwner":"babariviere/pilot","viewerPermission":"ADMIN"}'
        encrypted = '[secrets.DAY_UPDATER_PRIVATE_KEY]\nprovider = "age"\nvalue = "ciphertext-fixture"\n'
        decrypted = subprocess.CompletedProcess([], 0, b"fixture-key", b"")
        with (
            patch.object(sys, "argv", ["script", "--write"]),
            patch.object(Path, "read_text", return_value=encrypted),
            patch.object(signing, "verify_key"),
            patch.object(signing, "run", side_effect=[repo, b"public-fixture"]),
            patch.object(
                subprocess,
                "run",
                side_effect=[decrypted, subprocess.TimeoutExpired("gh", 60)],
            ) as child,
        ):
            with self.assertRaisesRegex(ValueError, "Unknown write outcome"):
                signing.main()
            self.assertEqual(child.call_count, 2)
            decrypt_env = child.call_args_list[0].kwargs["env"]
            self.assertIn("FNOX_AGE_KEY_FILE", decrypt_env)
            self.assertNotIn(signing.SECRET, decrypt_env)
            self.assertEqual(child.call_args.kwargs["input"], b"fixture-key")
            self.assertNotIn("fixture-key", " ".join(child.call_args.args[0]))

    def test_workflow_is_manual_main_only_without_signing(self):
        root = Path(__file__).resolve().parents[3]
        workflow = (root / ".github/workflows/day-signing-readiness.yml").read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertNotIn("push:", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertNotIn("FNOX_AGE_KEY", workflow)
        self.assertEqual(workflow.count("secrets."), 1)


if __name__ == "__main__":
    unittest.main()
