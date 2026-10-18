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
ISOLATED = "artifactHeightRespectsNestedClippingWhileKeepingVisibleOverflow"
ISOLATED_OUTPUT = STARTED + f"◇ Test {ISOLATED}() started.\n" + PASSED
DEVBOX = "addDevboxPresentsSetupSheetAfterCancelAndReopen"
DEVBOX_OUTPUT = STARTED + f"◇ Test {DEVBOX}() started.\n" + PASSED
TERMINAL = "terminalOpeningAndResizingDoNotFeedNativeFittingSizeBackIntoWindowConstraints"
TERMINAL_OUTPUT = STARTED + f"◇ Test {TERMINAL}() started.\n" + PASSED
CALLBACKS = ["localStopNormalizesQualifiedRowsAndRestoresWithdrawnMessages",
         "remoteStopKeepsCollidingLocalChatAndDraftUntouched",
         "unavailableStopNeverFallsBackToCurrentLocalHost",
             "missionTaskDragLoadsItsPlainTextOnTheMainActor"]
CALLBACKS_OUTPUT = STARTED + "".join(f"◇ Test {name}() started.\n" for name in CALLBACKS) + PASSED
JOURNEYS = ["keyboardOnlyStartSwitchTypeAndReturn", "keyboardOnlySidebarBrowsingKeepsFocusInTheSidebar"]
JOURNEYS_OUTPUT = STARTED + "".join(f"◇ Test {name}() started.\n" for name in JOURNEYS) + PASSED
GITHUB = ["githubKeySheetRequiresNativeConfirmationAndCancelDoesNotRegister"]
GITHUB_OUTPUTS = [STARTED + f"◇ Test {name}() started.\n" + PASSED for name in GITHUB]


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

    def run_wrapper(self, output, status=0, args=(), wrapper="test.sh", prepare_status=0,
                    second_output=None, second_status=0, all_calls=False,
                    third_output=DEVBOX_OUTPUT, third_status=0,
                    fourth_output=TERMINAL_OUTPUT, fourth_status=0,
                    fifth_output=CALLBACKS_OUTPUT, fifth_status=0,
                    sixth_output=None, sixth_status=0, extra_env=None, github_outputs=None):
        if sixth_output is None:
            sixth_output = JOURNEYS_OUTPUT
        extra_env = extra_env or {}
        # Exercise the actual shell wrapper without downloading/building the app.
        with tempfile.TemporaryDirectory(prefix="swift wrapper ") as directory:
            root = Path(directory)
            scripts = root / "apps/macos/scripts"
            scripts.mkdir(parents=True)
            (root / "scripts").mkdir()
            shutil.copy2(SCRIPTS.parents[2] / "scripts/verification-slot.py",
                         root / "scripts/verification-slot.py")
            for name in [wrapper, "check-test-output.py", "check-font-roles.py", "font-literals.txt"]:
                shutil.copy2(SCRIPTS / name, scripts / name)
            (scripts / "swift-env.sh").write_text("")
            for name in ["vendor-ghostty.sh", "vendor-mermaidkit.sh", "share-artifacts.sh"]:
                (scripts / name).write_text(f"#!/bin/sh\nexit {prepare_status}\n")
                (scripts / name).chmod(0o755)
            (root / "xcrun").write_text('#!/bin/sh\nprintf "%s\\n" "$FAKE_SWIFT"\n')
            (root / "xcrun").chmod(0o755)
            # The Nth swift call prints OUTPUT_N and exits with STATUS_N.
            (root / "swift").write_text(
                '#!/bin/sh\nprintf "__SWIFT_CALL__\\n" >> "$ARGUMENTS"\n'
                'printf "%s\\n" "$@" >> "$ARGUMENTS"\n'
                'n=$(($(cat "$COUNTER" 2>/dev/null || echo 0) + 1))\necho "$n" > "$COUNTER"\n'
                'eval "output=\\${OUTPUT_$n-}"\neval "status=\\${STATUS_$n-0}"\n'
                'printf "%s" "$output" >&2\nexit "$status"\n')
            (root / "swift").chmod(0o755)
            marker = root / "continued"
            arguments = root / "arguments"
            outputs = [(output, status), (ISOLATED_OUTPUT if second_output is None else second_output, second_status),
                       (third_output, third_status), (fourth_output, fourth_status), (fifth_output, fifth_status),
                       (sixth_output, sixth_status)]
            outputs += ([(text, 0) for text in GITHUB_OUTPUTS] if github_outputs is None else github_outputs)
            env = {**{key: value for key, value in os.environ.items() if key != "CI"},
                   "PATH": f"{root}:{os.environ['PATH']}",
                   "FAKE_SWIFT": str(root / "swift"), "ARGUMENTS": str(arguments), "PILOT_SWIFT_JOBS": "2",
                   "COUNTER": str(root / "swift-calls"),
                   "PILOT_HOME": str(root / "home"), "BUNDLE_RUNTIME": "0", **extra_env}
            for index, (text, code) in enumerate(outputs, start=1):
                env[f"OUTPUT_{index}"] = text
                env[f"STATUS_{index}"] = str(code)
            # Use macOS's Bash 3.2, not a newer Homebrew bash picked by env.
            result = subprocess.run(
                ["/bin/bash", "-c", '/bin/bash "$@" && touch "$CONTINUED"', "test", str(scripts / wrapper), *args],
                env={**env, "CONTINUED": str(marker)}, capture_output=True, text=True)
            calls = ([part.splitlines() for part in arguments.read_text().split("__SWIFT_CALL__\n")[1:]]
                     if arguments.exists() else [])
            return result, marker.exists(), calls if all_calls else calls[-1] if calls else []

    def test_full_suite_runs_window_interactions_separately_without_rebuilding(self):
        result, continued, calls = self.run_wrapper(PASSED, all_calls=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)
        self.assertEqual(len(calls), 6 + len(GITHUB))
        self.assertEqual(calls[0][-2:],
                         ["--skip", f"{ISOLATED}|{DEVBOX}|{TERMINAL}|{'|'.join(CALLBACKS)}|{'|'.join(JOURNEYS)}|{'|'.join(GITHUB)}"])
        self.assertNotIn("--skip-build", calls[0])
        self.assertIn("--skip-build", calls[1])
        self.assertEqual(calls[1][-2:], ["--filter", ISOLATED])
        self.assertIn("--skip-build", calls[2])
        self.assertEqual(calls[2][-2:], ["--filter", DEVBOX])
        self.assertIn("--skip-build", calls[3])
        self.assertEqual(calls[3][-2:], ["--filter", TERMINAL])
        self.assertIn("--skip-build", calls[4])
        self.assertEqual(calls[4][-2:], ["--filter", "|".join(CALLBACKS)])
        self.assertIn("--skip-build", calls[5])
        self.assertEqual(calls[5][-2:], ["--filter", "|".join(JOURNEYS)])
        for index, name in enumerate(GITHUB, start=6):
            self.assertIn("--skip-build", calls[index])
            self.assertEqual(calls[index][-2:], ["--filter", name])
        self.assertEqual(result.stderr.count("acquired slot 1/1"), 1)
        self.assertEqual(result.stdout, PASSED + ISOLATED_OUTPUT + DEVBOX_OUTPUT + TERMINAL_OUTPUT + CALLBACKS_OUTPUT
                         + JOURNEYS_OUTPUT + "".join(GITHUB_OUTPUTS))

    def test_isolated_journeys_are_required_only_on_ci(self):
        # Outside CI the journeys are disabled, so an empty run passes.
        result, continued, calls = self.run_wrapper(PASSED, sixth_output=PASSED, all_calls=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)
        self.assertEqual(len(calls), 6 + len(GITHUB))
        outputs = [(PASSED, 0), (JOURNEYS_OUTPUT + FAILED, 0), (JOURNEYS_OUTPUT, 42)]
        for name in JOURNEYS:
            outputs.append((JOURNEYS_OUTPUT.replace(f"◇ Test {name}() started.\n", ""), 0))
        for output, status in outputs:
            result, continued, _ = self.run_wrapper(PASSED, sixth_output=output, sixth_status=status,
                                                    extra_env={"CI": "true"})
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse(continued)
        result, continued, _ = self.run_wrapper(PASSED, extra_env={"CI": "true"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)

    def test_isolated_callbacks_require_every_test_and_preserve_failures(self):
        outputs = [("", 0), (PASSED, 0), (CALLBACKS_OUTPUT + FAILED, 0), (CALLBACKS_OUTPUT, 42)]
        for name in CALLBACKS:
            outputs.append((CALLBACKS_OUTPUT.replace(f"◇ Test {name}() started.\n", ""), 0))
        for output, status in outputs:
            result, continued, calls = self.run_wrapper(PASSED, fifth_output=output,
                                                       fifth_status=status, all_calls=True)
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse(continued)
            self.assertEqual(len(calls), 5)

    def test_isolated_github_controls_require_each_test_and_preserve_failures(self):
        for index, name in enumerate(GITHUB):
            for output, status in [("", 0), (PASSED, 0),
                                   (STARTED + f"◇ Test {name}() started.\n", 0),
                                   (GITHUB_OUTPUTS[index] + FAILED, 0), (GITHUB_OUTPUTS[index], 42)]:
                outputs = [(text, 0) for text in GITHUB_OUTPUTS]
                outputs[index] = (output, status)
                result, continued, calls = self.run_wrapper(PASSED, github_outputs=outputs, all_calls=True)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertFalse(continued)
                self.assertEqual(len(calls), 7 + index)

    def test_isolated_terminal_must_start_finish_and_pass(self):
        for output, status in [("", 0), (PASSED, 0),
                               (STARTED + f"◇ Test {TERMINAL}() started.\n", 0),
                               (TERMINAL_OUTPUT + FAILED, 0), (TERMINAL_OUTPUT, 42)]:
            result, continued, calls = self.run_wrapper(PASSED, fourth_output=output,
                                                       fourth_status=status, all_calls=True)
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse(continued)
            self.assertEqual(len(calls), 4)

    def test_isolated_devbox_must_start_finish_and_pass(self):
        for output, status in [("", 0), (PASSED, 0),
                               (STARTED + f"◇ Test {DEVBOX}() started.\n", 0),
                               (DEVBOX_OUTPUT + FAILED, 0), (DEVBOX_OUTPUT, 42)]:
            result, continued, calls = self.run_wrapper(PASSED, third_output=output,
                                                       third_status=status, all_calls=True)
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse(continued)
            self.assertEqual(len(calls), 3)

    def test_isolated_geometry_failures_and_driver_status_stop_chain(self):
        for output, status in [(STARTED + f"◇ Test {ISOLATED}() started.\n" + FAILED, 0),
                               ("error: driver failed\n", 42)]:
            result, continued, calls = self.run_wrapper(PASSED, second_output=output,
                                                        second_status=status, all_calls=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(continued)
            self.assertEqual(len(calls), 2)

    def test_isolated_geometry_must_actually_run(self):
        for output in ["", "No matching tests\n", PASSED]:
            result, continued, _ = self.run_wrapper(PASSED, second_output=output)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(continued)
            self.assertIn("required native test did not start", result.stderr)

    def test_isolated_geometry_start_without_terminal_summary_stops_chain(self):
        output = STARTED + f"◇ Test {ISOLATED}(kind:inline:) started.\n"
        result, continued, calls = self.run_wrapper(PASSED, second_output=output, all_calls=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(continued)
        self.assertEqual(len(calls), 2)
        self.assertIn("started without a terminal summary", result.stderr)
        self.assertNotIn("required native test did not start", result.stderr)

    def test_isolated_geometry_accepts_parameterized_parent_start(self):
        output = STARTED + f"◇ Test {ISOLATED}(kind:inline:) started.\n" + PASSED
        result, continued, _ = self.run_wrapper(PASSED, second_output=output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)

    def test_explicit_selection_and_listing_remain_single_invocation(self):
        for args in [("--filter", ISOLATED), ("--filter=other",), ("--skip", ISOLATED),
                     ("--skip=other",), ("--list-tests",), ("list",), ("--version",)]:
            result, continued, calls = self.run_wrapper(PASSED, args=args, all_calls=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(continued)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][-len(args):], list(args))

    def test_explicit_build_options_still_partition_full_suite(self):
        result, _, calls = self.run_wrapper(PASSED, args=("--jobs=1", "--skip-build"), all_calls=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 6 + len(GITHUB))
        for call in calls:
            self.assertIn("--jobs=1", call)
            self.assertNotIn("--jobs", call)
            self.assertEqual(call.count("--skip-build"), 1)

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
