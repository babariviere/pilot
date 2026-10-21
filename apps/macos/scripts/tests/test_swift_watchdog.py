import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "run-swift-tests.py"
spec = importlib.util.spec_from_file_location("swift_watchdog", SCRIPT)
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)


class SwiftWatchdogTests(unittest.TestCase):
    def run_fixture(self, source, build=2, tests=1):
        # Never run native profilers in this suite. Diagnose's ownership is tested separately.
        with tempfile.TemporaryDirectory() as directory:
            sample = Path(directory) / "sample"
            sample.write_text("#!/bin/sh\nprintf 'fixture stack sample\\n'\n")
            sample.chmod(0o755)
            return subprocess.run(
                [sys.executable, str(SCRIPT), "--build-timeout", str(build),
                 "--test-timeout", str(tests), "--", sys.executable, "-u", "-c", source],
                env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]},
                capture_output=True, timeout=10)

    def test_preserves_output_status_and_signal_failures(self):
        for code, status in [("print('fixture output')", 0),
                             ("import sys; print('failure'); sys.exit(42)", 42),
                             ("import os,signal; os.kill(os.getpid(), signal.SIGTERM)", 143)]:
            with self.subTest(code=code):
                result = self.run_fixture(code)
                self.assertEqual(result.returncode, status, result.stderr)
                if "print" in code:
                    self.assertIn(b"fixture output" if status == 0 else b"failure", result.stdout)
                self.assertIn(b"invocation finished", result.stderr)

    def test_build_time_does_not_consume_the_test_budget_and_each_runner_gets_a_budget(self):
        result = self.run_fixture(
            "import time; time.sleep(.25); print('◇ Test run started.'); time.sleep(.2); "
            "print('✔ Test run with 1 test passed after 0.2 seconds.'); "
            "print('◇ Test run started.'); time.sleep(.2)", build=2, tests=.35)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_hung_tests_timeout_even_while_printing_and_capture_diagnostics(self):
        result = self.run_fixture(
            "import time; print('◇ Test run started.'); "
            "exec(\"while True:\\n print('still busy'); time.sleep(.01)\")", build=2, tests=.2)
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertIn(b"Swift tests exceeded its deadline", result.stderr)
        if sys.platform == "darwin":
            self.assertIn(b"fixture stack sample", result.stderr)

    def test_startup_and_closed_stdout_shutdown_are_bounded(self):
        for source in ["import time; time.sleep(10)",
                       "import os,time; os.close(1); os.close(2); time.sleep(10)"]:
            result = self.run_fixture(source, build=.2)
            self.assertEqual(result.returncode, 124, result.stderr)

    def test_descendant_holding_stdout_is_killed_without_touching_another_process_group(self):
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"], start_new_session=True)
        try:
            result = self.run_fixture(
                "import os,subprocess,sys; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(20)'], "
                "preexec_fn=os.setpgrp); "
                "print(child.pid)", build=.2)
            self.assertEqual(result.returncode, 124, result.stderr)
            self.assertIsNone(unrelated.poll())
            pid = int(result.stdout.strip())
            state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
            self.assertTrue(not state or state.startswith("Z"), state)
        finally:
            unrelated.kill()
            unrelated.wait()

    def test_external_termination_also_joins_group_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "pid"
            process = subprocess.Popen(
                [sys.executable, str(SCRIPT), "--", sys.executable, "-c",
                 f"import os,pathlib,time; pathlib.Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(20)"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(marker.exists())
                pid = int(marker.read_text())
                process.terminate()
                _, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 143, stderr)
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate()

    def test_diagnostics_sample_only_owned_native_runners(self):
        listing = subprocess.CompletedProcess([], 0, stdout="11 10 swift\n12 10 swiftpm-testing-helper\n13 99 xctest\n")
        with patch.object(watchdog.sys, "platform", "darwin"), \
             patch.object(watchdog.os, "getsid", side_effect=lambda pid: 10 if pid in (11, 12) else 99), \
             patch.object(watchdog.subprocess, "run", return_value=listing) as run:
            watchdog.diagnose(10)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[1].args[0], ["sample", "12", "1", "1"])

    def test_cleanup_never_signals_special_groups_or_the_supervisors_group(self):
        from unittest.mock import Mock
        process = Mock(pid=10)
        process.poll.return_value = 0
        with patch.object(watchdog, "owned_processes", return_value=[
            (10, 0, "zombie"), (11, 1, "special"), (12, 99, "supervisor"), (13, 13, "helper")
        ]), patch.object(watchdog.os, "getpgrp", return_value=99), patch.object(watchdog.os, "killpg") as kill:
            watchdog.cleanup_session(process)
        kill.assert_called_once_with(13, signal.SIGKILL)
        process.kill.assert_not_called()
        process.wait.assert_called_once()

    def test_rejects_invalid_deadlines_before_starting_a_command(self):
        for value in ["0", "-1", "nan", "inf"]:
            result = subprocess.run([sys.executable, str(SCRIPT), "--test-timeout", value, "--", "false"],
                                    capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2, result.stderr)


if __name__ == "__main__":
    unittest.main()
