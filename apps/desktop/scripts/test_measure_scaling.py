"""Mocked runner tests: never starts a native process or reads real state."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

SCRIPT = Path(__file__).with_name("measure-scaling.py")

class RunnerTests(unittest.TestCase):
    def run_wrapper(self, child, error=None):
        with tempfile.TemporaryDirectory() as root:
            executable = Path(root) / "synthetic-not-executed"
            executable.write_bytes(b"synthetic binary fixture")
            arguments = [str(SCRIPT), str(executable), "--base-patch-sha256", "a" * 64,
                         "--runs", "1", "--cases", "paragraphs", "--sizes", "65536"]
            output, diagnostic = io.StringIO(), io.StringIO()
            with patch.object(sys, "argv", arguments), patch("platform.system", return_value="Darwin"), \
                    patch("platform.platform", return_value="synthetic"), patch("signal.signal"), \
                    patch("subprocess.Popen", return_value=child) as launch, \
                    patch("os.killpg") as kill, contextlib.redirect_stdout(output), \
                    contextlib.redirect_stderr(diagnostic):
                if error:
                    with self.assertRaises(error):
                        runpy.run_path(str(SCRIPT), run_name="__main__")
                else:
                    runpy.run_path(str(SCRIPT), run_name="__main__")
                return output.getvalue(), diagnostic.getvalue(), launch, kill

    def test_success_freezes_and_uses_only_allowlisted_environment(self):
        child = MagicMock(pid=54321, returncode=0)
        child.communicate.return_value = (json.dumps({"ready_wall_ms": 1, "source_ready_and_full_copy_asserted": True}),
                                          "123 maximum resident set size")
        output, _, launch, kill = self.run_wrapper(child)
        result = json.loads(output)
        self.assertEqual(result["base_patch_sha256"], "a" * 64)
        self.assertEqual(result["runs"][0]["peak_rss_bytes"], 123)
        self.assertEqual(set(launch.call_args.kwargs["env"]), {"PATH", "HOME", "TMPDIR", "LANG"})
        self.assertTrue(launch.call_args.kwargs["start_new_session"])
        child.communicate.assert_called_once_with(timeout=120)
        kill.assert_not_called()

    def test_timeout_kills_the_owned_group_even_if_time_parent_already_exited(self):
        child = MagicMock(pid=54321, returncode=0)
        child.poll.return_value = 0
        child.communicate.side_effect = [subprocess.TimeoutExpired("synthetic", 120, stderr=b"selected source frame"), ("", "")]
        _, diagnostic, _, kill = self.run_wrapper(child, subprocess.TimeoutExpired)
        kill.assert_called_once_with(54321, signal.SIGKILL)
        self.assertEqual(child.communicate.call_count, 2)
        self.assertIn("selected source frame", diagnostic)
        self.assertIn('"timeout_seconds": 120', diagnostic)

    def test_cancellation_also_kills_and_joins_the_owned_group(self):
        child = MagicMock(pid=54321, returncode=None)
        child.communicate.side_effect = [SystemExit(143), ("", "")]
        _, _, _, kill = self.run_wrapper(child, SystemExit)
        kill.assert_called_once_with(54321, signal.SIGKILL)
        self.assertEqual(child.communicate.call_count, 2)

    def test_native_failure_is_not_reported_as_success(self):
        child = MagicMock(pid=54321, returncode=101)
        child.communicate.return_value = ("", "synthetic assertion failed")
        output, diagnostic, _, kill = self.run_wrapper(child, SystemExit)
        self.assertEqual(output, "")
        self.assertIn("synthetic assertion failed", diagnostic)
        self.assertIn('"returncode": 101', diagnostic)
        kill.assert_not_called()

if __name__ == "__main__":
    unittest.main()
