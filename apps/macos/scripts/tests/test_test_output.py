import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1]
GUARD = SCRIPTS / "check-test-output.py"
spec = importlib.util.spec_from_file_location("check_test_output", GUARD)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

FAILED = '✘ Test run with 1 test in 1 suite failed after 0.001 seconds with 1 issue.\n'
PASSED = ('✔ Test run with 122 tests in 9 suites passed after 0.100 seconds.\n'
          '✔ Test run with 221 tests in 12 suites passed after 0.200 seconds.\n')
STARTED = '◇ Test run started.\n'


class TestOutputTests(unittest.TestCase):
    def test_summaries_not_warning_prose(self):
        for line in [FAILED, '\x1b[31m' + FAILED + '\x1b[0m',
                     '✘ Test run with 1 test failed after 0.001 seconds with 1 issue.',
                     "Test Suite 'All tests' failed at 2026-10-13 10:00:00."]:
            self.assertTrue(guard.failed_summary(line), line)
        for line in [PASSED, 'warning: failed to find optional resource',
                     'warning: ' + FAILED, '✔ Test expectedFailure() passed with 1 known issue.',
                     '◇ Test named "failed after" started.', 'Build complete!']:
            self.assertFalse(guard.failed_summary(line), line)

    def run_wrapper(self, output, status=0, args=(), wrapper="test.sh", prepare_status=0):
        # Exercise the actual shell wrapper without downloading/building the app.
        with tempfile.TemporaryDirectory(prefix="swift wrapper ") as directory:
            root = Path(directory)
            scripts = root / "apps/macos/scripts"
            scripts.mkdir(parents=True)
            (root / "scripts").mkdir()
            shutil.copy2(SCRIPTS.parents[2] / "scripts/verification-slot.py",
                         root / "scripts/verification-slot.py")
            for name in [wrapper, "check-test-output.py"]:
                shutil.copy2(SCRIPTS / name, scripts / name)
            (scripts / "swift-env.sh").write_text("")
            for name in ["vendor-ghostty.sh", "share-artifacts.sh"]:
                (scripts / name).write_text(f"#!/bin/sh\nexit {prepare_status}\n")
                (scripts / name).chmod(0o755)
            (root / "xcrun").write_text('#!/bin/sh\nprintf "%s\\n" "$FAKE_SWIFT"\n')
            (root / "xcrun").chmod(0o755)
            (root / "swift").write_text(
                '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGUMENTS"\n'
                'printf "%s" "$TEST_OUTPUT" >&2\nexit "$TEST_STATUS"\n')
            (root / "swift").chmod(0o755)
            marker = root / "continued"
            arguments = root / "arguments"
            env = {**os.environ, "PATH": f"{root}:{os.environ['PATH']}",
                   "FAKE_SWIFT": str(root / "swift"), "TEST_OUTPUT": output,
                   "TEST_STATUS": str(status), "ARGUMENTS": str(arguments), "PILOT_SWIFT_JOBS": "2",
                   "PILOT_HOME": str(root / "home"), "BUNDLE_RUNTIME": "0"}
            # Use macOS's Bash 3.2, not a newer Homebrew bash picked by env.
            result = subprocess.run(
                ["/bin/bash", "-c", '/bin/bash "$@" && touch "$CONTINUED"', "test", str(scripts / wrapper), *args],
                env={**env, "CONTINUED": str(marker)}, capture_output=True, text=True)
            return result, marker.exists(), arguments.read_text().splitlines() if arguments.exists() else []

    def test_all_swift_entrypoints_hold_a_slot_before_package_preparation(self):
        for wrapper in ["build.sh", "test.sh", "bundle.sh"]:
            with self.subTest(wrapper=wrapper):
                result, continued, _ = self.run_wrapper("", wrapper=wrapper, prepare_status=42)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertFalse(continued)
                self.assertEqual(result.stderr.count("acquired slot 1/1"), 1)

    def test_build_preserves_arguments_and_handles_empty_default_jobs_on_bash_3(self):
        result, continued, arguments = self.run_wrapper("", wrapper="build.sh", args=("--jobs=1", "--version"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)
        self.assertNotIn("--jobs", arguments)
        self.assertEqual(arguments[-2:], ["--jobs=1", "--version"])

    def test_failed_target_then_two_successes_stops_chain(self):
        output = '✘ Test offscreenLookup() recorded an issue: Expectation failed\n' + FAILED + PASSED
        result, continued, _ = self.run_wrapper(output)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(continued)
        self.assertEqual(result.stdout, output)
        self.assertIn("native test target failed", result.stderr)

    def test_started_runner_without_terminal_summary_stops_chain(self):
        output = STARTED + '✘ Test restoredBranchWaitsForProjectDiscovery() recorded an issue: expectation failed\n'
        result, continued, _ = self.run_wrapper(output)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(continued)
        self.assertEqual(result.stdout, output)
        self.assertIn("started without a terminal summary", result.stderr)
        self.assertIn("native test target failed", result.stderr)

    def test_started_runner_needs_a_terminal_even_without_failure_text(self):
        result, continued, _ = self.run_wrapper(STARTED)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(continued)
        self.assertIn("started without a terminal summary", result.stderr)

    def test_each_started_runner_needs_its_own_terminal_summary(self):
        output = STARTED + PASSED.splitlines(keepends=True)[0] + STARTED
        result, continued, _ = self.run_wrapper(output)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(continued)
        self.assertIn("1 native test runner(s) started without a terminal summary", result.stderr)

    def test_expected_failure_is_not_a_recorded_failure(self):
        output = STARTED + '✔ Test expectedFailure() passed with 1 known issue.\n'
        output += '✔ Test run with 1 test in 1 suite passed after 0.100 seconds.\n'
        result, continued, _ = self.run_wrapper(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)

    def test_xctest_started_runner_without_terminal_summary(self):
        output = "Test Suite 'All tests' started at 2026-10-13 10:00:00.\n"
        result, continued, _ = self.run_wrapper(output)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(continued)
        self.assertIn("started without a terminal summary", result.stderr)

    def test_success_and_warning_continue_chain(self):
        output = 'warning: optional lookup failed\n' + PASSED
        result, continued, arguments = self.run_wrapper(output, args=("--filter", "normalSuccess"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)
        self.assertEqual(result.stdout, output)
        self.assertIn("--jobs", arguments)
        self.assertEqual(arguments[-2:], ["--filter", "normalSuccess"])

    def test_driver_failure_without_summary_stops_chain(self):
        result, continued, _ = self.run_wrapper('error: build failed\n', status=42)
        self.assertEqual(result.returncode, 42)
        self.assertFalse(continued)

    def test_explicit_jobs_and_non_running_command(self):
        result, continued, arguments = self.run_wrapper('Swift version 6.4\n', args=("--jobs=1", "--version"))
        self.assertEqual(result.returncode, 0)
        self.assertTrue(continued)
        self.assertNotIn("--jobs", arguments)

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("swift"), "requires macOS Swift Testing")
    def test_real_swift_testing_failed_target_and_normal_success(self):
        # Keep a real #require regression as well as the deterministic driver-0
        # reproduction above. No app dependencies or permanently failing app test.
        with tempfile.TemporaryDirectory(prefix="swift targets ") as directory:
            root = Path(directory)
            (root / "Package.swift").write_text('''// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "RunnerRegression", targets: [
    .testTarget(name: "FailingTests"), .testTarget(name: "PassingTests")
])
''')
            for target, source in {
                "FailingTests": '''import Foundation
import Testing
@Test func requireRegression() throws {
    try #require(ProcessInfo.processInfo.environment["FAIL_TARGET"] != "1")
}
''',
                "PassingTests": '''import Foundation
import Testing
@Test func normalSuccess() { #expect(true) }
@Test @MainActor func stoppedMainLoopStillFinishes() async throws {
    DispatchQueue.main.async { CFRunLoopStop(CFRunLoopGetMain()) }
    try await Task.sleep(for: .milliseconds(50))
    #expect(true)
}
''',
            }.items():
                folder = root / "Tests" / target
                folder.mkdir(parents=True)
                (folder / "Tests.swift").write_text(source)
            shutil.copy2(SCRIPTS.parent / "Tests/PilotUITests/TestMainLoop.swift",
                         root / "Tests/PassingTests/TestMainLoop.swift")
            swift = subprocess.check_output(["xcrun", "--find", "swift"], text=True).strip()
            plugins = str(Path(swift).parent / "../lib/swift/host/plugins/testing")
            for fail in ["1", "0"]:
                result = subprocess.run(
                    [sys.executable, str(SCRIPTS.parents[2] / "scripts/verification-slot.py"), "swift", "--",
                     "swift", "test", "--package-path", str(root), "--build-system", "native", "--jobs", "2",
                     "-Xswiftc", "-plugin-path", "-Xswiftc", plugins],
                    env={**os.environ, "FAIL_TARGET": fail}, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, timeout=120)
                checked = subprocess.run([sys.executable, str(GUARD)], input=result.stdout, capture_output=True)
                self.assertEqual(checked.stdout, result.stdout)
                self.assertEqual(checked.returncode, int(fail), result.stdout.decode())
                self.assertIn(b"stoppedMainLoopStillFinishes() passed", result.stdout)
                if fail == "0":
                    self.assertEqual(result.returncode, 0, result.stdout.decode())


if __name__ == "__main__":
    unittest.main()
