"""Stall diagnostics use mocked clocks/processes, never Swift or AppKit."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "check-test-output.py"
spec = importlib.util.spec_from_file_location("stall_guard", SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class StallTests(unittest.TestCase):
    def make_sampler(self):
        now, captured = [0], []
        return guard.StallSampler(60, lambda: captured.append(True), lambda: now[0]), now, captured

    def test_build_silence_is_not_a_stalled_runner(self):
        sampler, now, captured = self.make_sampler()
        now[0] = 600
        self.assertFalse(sampler.capture_if_due())
        self.assertEqual(captured, [])

    def test_progress_resets_deadline_and_capture_is_once(self):
        sampler, now, captured = self.make_sampler()
        sampler.progress(True)
        now[0] = 59
        self.assertFalse(sampler.capture_if_due())
        sampler.progress(True)
        now[0] = 60
        self.assertFalse(sampler.capture_if_due())
        now[0] = 119
        self.assertTrue(sampler.capture_if_due())
        sampler.progress(True)
        now[0] = 1000
        self.assertFalse(sampler.capture_if_due())
        self.assertEqual(captured, [True])

    def test_completed_or_closed_runner_does_not_sample(self):
        for closed in [False, True]:
            with self.subTest(closed=closed):
                sampler, now, captured = self.make_sampler()
                sampler.progress(True)
                if closed:
                    sampler.close()
                else:
                    sampler.progress(False)
                now[0] = 600
                self.assertFalse(sampler.capture_if_due())
                self.assertEqual(captured, [])

    def test_in_process_parser_preserves_bytes_and_drives_sampler_activity(self):
        for terminal, status in [("✔ Test run with 1 test passed after 0.1 seconds.\n", 0), ("", 1)]:
            with self.subTest(terminal=terminal):
                sampler, _now, captured = self.make_sampler()
                raw = b"building: \xff\n" + "◇ Test run started.\n◇ Test required() started.\n".encode() + terminal.encode()
                output, diagnostics = io.BytesIO(), io.StringIO()
                result = guard.check_output(io.BytesIO(raw), output, diagnostics, ["required"], sampler=sampler)
                self.assertEqual(result, status)
                self.assertEqual(output.getvalue(), raw)
                self.assertEqual(sampler.active, not bool(terminal))
                self.assertEqual(captured, [])
                self.assertEqual(bool(diagnostics.getvalue()), bool(status))

    def test_cli_closes_sampler_even_if_streaming_parser_raises(self):
        with patch.object(guard.sys, "argv", [str(SCRIPT), "--sample-stalled-after", "60"]), \
                patch.object(guard, "StallSampler") as constructor, \
                patch.object(guard, "check_output", side_effect=OSError("fixture stream closed")):
            with self.assertRaisesRegex(OSError, "fixture stream closed"):
                guard.main()
            constructor.return_value.thread.start.assert_called_once_with()
            constructor.return_value.close.assert_called_once_with()

    def test_thread_wakes_on_progress_and_closes(self):
        captured = threading.Event()
        sampler = guard.StallSampler(0.01, captured.set)
        sampler.thread.start()
        try:
            sampler.progress(True)
            self.assertTrue(captured.wait(2))
        finally:
            sampler.close()
        self.assertFalse(sampler.thread.is_alive())

    def test_scope_follows_ancestors_not_names_or_row_order(self):
        table = """12 11 /tool/swiftpm-testing
11 10 /tool/swift-package
10 1 /bin/bash
20 1 /bin/bash
21 20 /tool/swiftpm-testing
13 12 /fixture/node
14 11 /some path/OtherPackageTests
15 11 /tool/xctest
16 11 /tool/not-tests
malformed table
"""
        self.assertEqual(guard.descendant_runners(table, 10), [12, 14])
        self.assertEqual(guard.descendant_runners(table, 20), [21])
        self.assertEqual(guard.descendant_runners(table, 30), [])

    def test_bounded_sample_persists_full_trace_and_prints_excerpt(self):
        with tempfile.TemporaryDirectory() as directory:
            commands, output = [], io.StringIO()

            def run(command, **kwargs):
                commands.append((command, kwargs))
                if command[0] == "/bin/ps":
                    return subprocess.CompletedProcess(command, 0, "44 1 /bin/bash\n45 44 /tool/swiftpm-testing")
                Path(command[-1]).write_text("stack\n" + "x" * 30000)
                return subprocess.CompletedProcess(command, 0)

            with patch.dict(os.environ, {"RUNNER_TEMP": directory}), patch.object(guard.subprocess, "run", run), \
                    contextlib.redirect_stderr(output):
                guard.sample_stalled_runners(44)
            self.assertEqual(commands[0][1]["timeout"], 5)
            self.assertEqual(commands[0][0][1], "-wwaxo")
            self.assertEqual(commands[1][0][:4], ["/usr/bin/sample", "45", "2", "-file"])
            self.assertEqual(commands[1][1]["timeout"], 10)
            self.assertEqual(len(list(Path(directory).glob("swift-test-stalls/*.sample.txt"))), 1)
            self.assertLess(len(output.getvalue()), 24500)
            self.assertEqual(len(Path(commands[1][0][-1]).read_text()), 30006)

    def test_diagnostic_failure_does_not_escape_or_echo_process_arguments(self):
        output = io.StringIO()
        with patch.object(guard.subprocess, "run", side_effect=subprocess.TimeoutExpired("private-command", 5)), \
                contextlib.redirect_stderr(output):
            guard.sample_stalled_runners(44)
        self.assertIn("discovery unavailable: TimeoutExpired", output.getvalue())
        self.assertNotIn("private-command", output.getvalue())

    def test_sample_failure_is_best_effort(self):
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RUNNER_TEMP": directory}), \
                patch.object(guard.subprocess, "run", side_effect=[
                    subprocess.CompletedProcess([], 0, "45 44 /tool/swiftpm-testing"),
                    subprocess.CalledProcessError(1, "sample")]), contextlib.redirect_stderr(output):
            guard.sample_stalled_runners(44)
        self.assertIn("sample unavailable: CalledProcessError", output.getvalue())

    def test_long_xcode_paths_and_swift_testing_helper_keep_owner_scope(self):
        path = "/Applications/" + "Xcode_26.2/" * 20
        table = f"45 44 {path}swift-testing-helper\n46 44 {path}PilotMacPackageTests.xctest\n47 99 {path}swift-testing-helper"
        self.assertEqual(guard.descendant_runners(table, 44), [45, 46])
        self.assertEqual(guard.descendant_runners(table, 99), [47])

    def test_empty_discovery_prints_only_bounded_owned_command_names(self):
        table = "\n".join(f"{i} 44 /private/runner/helper-{i}" for i in range(100, 140))
        table += "\n999 1 /private/other-checkout/private-peer-command"
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RUNNER_TEMP": directory}), \
                patch.object(guard.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, table)), \
                contextlib.redirect_stderr(output):
            guard.sample_stalled_runners(44)
        self.assertIn("Swift stall owner PID: 44", output.getvalue())
        self.assertIn("helper-131", output.getvalue())
        self.assertNotIn("helper-132", output.getvalue())
        self.assertNotIn("private-peer-command", output.getvalue())
        self.assertNotIn("/private/runner", output.getvalue())

    def test_enabled_guard_keeps_original_output_and_failure_semantics(self):
        for text, code in [("◇ Test run started.\n✔ Test run with 1 test passed after 0.1 seconds.\n", 0),
                           ("◇ Test run started.\n", 1),
                           ("◇ Test run started.\n✘ Test run with 1 test failed after 0.1 seconds.\n", 1)]:
            result = subprocess.run([os.sys.executable, str(SCRIPT), "--sample-stalled-after", "60"],
                                    input=text, text=True, capture_output=True, timeout=5)
            self.assertEqual(result.stdout, text)
            self.assertEqual(result.returncode, code)
            self.assertNotIn("sampling runner", result.stderr)

    def test_invalid_intervals_are_rejected(self):
        for seconds in ["0", "-1", "nan", "inf"]:
            result = subprocess.run([os.sys.executable, str(SCRIPT), "--sample-stalled-after", seconds],
                                    input="", text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertIn("finite and positive", result.stderr)

    def test_invalid_parent_pids_are_rejected(self):
        for pid in ["0", "-1"]:
            result = subprocess.run([os.sys.executable, str(SCRIPT), "--runner-parent-pid", pid],
                                    input="", text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertIn("must be positive", result.stderr)


if __name__ == "__main__":
    unittest.main()
