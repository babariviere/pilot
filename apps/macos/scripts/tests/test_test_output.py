import importlib.util
import io
import json
import os
import re
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
DEVBOX = "retiredDevboxesKeepSettingsLocalAndCachedHistoryReadOnly"
DEVBOX_OUTPUT = STARTED + f"◇ Test {DEVBOX}() started.\n" + PASSED
TERMINAL = "terminalOpeningAndResizingDoNotFeedNativeFittingSizeBackIntoWindowConstraints"
TERMINAL_OUTPUT = STARTED + f"◇ Test {TERMINAL}() started.\n" + PASSED
CALLBACKS = [
             "missionTaskDragLoadsItsPlainTextOnTheMainActor"]
CALLBACKS_OUTPUT = STARTED + "".join(f"◇ Test {name}() started.\n" for name in CALLBACKS) + PASSED
JOURNEYS = ["keyboardOnlyStartSwitchTypeAndReturn", "keyboardOnlySidebarBrowsingKeepsFocusInTheSidebar"]
JOURNEY_START_OUTPUT = STARTED + f"◇ Test {JOURNEYS[0]}() started.\n" + PASSED
JOURNEY_SIDEBAR_OUTPUT = STARTED + f"◇ Test {JOURNEYS[1]}() started.\n" + PASSED
SCOPED_MODELS = ['localModelScopePersistsIntentBeforeItsOnlyWriteAndRejectsRemoteEndpoints', 'localModelScopeLostAckUsesExactReadbackAndKeepsRetryBudgetAcrossRelaunch', 'localModelScopeConflictAndLeaveCannotBeOverwrittenByAnotherSave', 'localModelScopeReplacementWaitsForOldWriteWithoutPublishingStaleSuccess', 'localModelScopeSupersededSavesApplyOnlyTheLatestPendingSelection']
SCOPED_MODEL_TRANSPORT = ["modelScopeLiveOwnerNeverSyncsRetiredDevboxes", "modelScopeLiveConflictAndLeaveRemainDivergentAfterColdLaunch", "modelScopeWirePreservesAllAndDecodesBothPutArmsWithoutCapabilityReadsOnGet", "modelScopeWireRejectsStaleCapabilityAcquisitionBeforeSending", "modelScopeWireExposesTypedReadFailuresWithoutTreatingThemAsAbsent", "modelScopeWireReconcilesCommitted503WithLiteralReadbackWithoutRepeatingPut"]
SCOPED_MODELS += SCOPED_MODEL_TRANSPORT
SCOPED_MODEL_NATIVE = ["scopedModelsNativeSavePersistsAndDispatchesExplicitAllOnlyAfterClick",
                       "scopedModelsNativeSelectorPreservesAdvancedPatterns",
                       "scopedModelsNativeSaveUsesHostOwnerCapabilityHttpAndLiteralReadback"]
SCOPED_MODEL_OUTPUTS = [STARTED + "".join(f"◇ Test {name}() started.\n" for name in SCOPED_MODELS) + PASSED]
SCOPED_MODEL_OUTPUTS += [STARTED + f"◇ Test {name}() started.\n" + PASSED for name in SCOPED_MODEL_NATIVE]


AUTOMATIC_UPDATES = [
    "retiredOfflineRestoreKeepsLegacyBytesAndUnknownOutboxWithoutNetwork",
    "retiredLocalDraftParksUnsubmittedRemoteTextWithoutRetargeting",
    "retiredRemoteProjectsCannotStartOrImportChats",
    "retiredCorruptOfflineMetadataCannotBlockLocalOrReplaceSavedFiles",
]
AUTOMATIC_UPDATE_OUTPUTS = [STARTED + "".join(f"◇ Test {name}() started.\n" for name in AUTOMATIC_UPDATES) + PASSED]
USAGE_PROJECTION = "usageLocalConsumerNeverFansOutAndDeferredHelperRequiresExplicitHosts"

REGRESSION_PARTITIONS = [
    ["productionFooterStaysFixedWhileReadingLongHistoryAndKeepsTheComposer",
     "questionWorkingPendingAndErrorTransitionsLeaveTheFooterReachable",
     "originalPendingStartRemainsCheckableWithoutAProposalAndOfflineActionsStayDisabled"],
    ["settingsSaveBarMountsForDirtyFormAndLeavesAfterRevert"],
    ["visualSliderDragsCoalesceToOneHandlerInFlightEndingAtTheLastPosition", "visualDiscreteEventsRunInOrder",
     "missionNavigationAndPaletteKeepCanonicalPinsAcrossExecutionChangesAndRetainedSnapshots",
     "sidebarPollsOnlyBranchesAndLoadsCountsOnDemand", USAGE_PROJECTION,
     "usageDashboardLocalOnlyCacheAndPagesNeverAddCheckpointOrRepeatedTotals",
     "usageDashboardUnsupportedCapacityErrorsAndAmbiguousLocalAreNotZero",
     "usageDashboardStaleScopeAndConnectionResponsesCannotRepaintOrReuseCache",
     "usageDashboardNavigationIsAvailableWithoutConfiguration",
     "usageDashboardRefreshPaginatesTrendsAndDoesNotRejectOrdinaryHistoryUpdates",
     "usageDashboardUnavailableSecondaryReadsStayUnknownUntilExplicitRefresh",
     "usageDashboardLateTrendCannotOverwriteRefreshOrMixErasureGenerations"]
]
REGRESSION_OUTPUTS = [STARTED + "".join(f"◇ Test {name}() started.\n" for name in names) + PASSED
                      for names in REGRESSION_PARTITIONS]
NATIVE_POINTERS = [
    "swiftUIExpandedArtifactCloseAndEscapeLeaveTheChatUsable",
    "usageDashboardMountedControlsReadLocalRangesFoldAndPageInBothAppearances",
    "diagnoseSetupSubmitsReasonOrBlankThroughMountedControls",
    "diagnoseReasonBoundsApplyToButtonAndKeyboardAndCancelStartsNothing",
    "diagnoseStartErrorKeepsReasonForKeyboardRetryAndAskStillSubmits",
    "nativeControlsActivateOnlyEnabledProductionActions",
    "nativeRepairPromptButtonsOnlyReviewOrDismissAndNeverSpawn",
    "mountedDiagnosticsFooterSubmitsOnceAndNeverStartsRepair",
    "mountedDiagnosticsFooterReviewsAnExistingProposalWithoutStartingWork",
    "slackTriageRefreshIsClickableAndDisablesDuringLocalAndAutomaticSync",
    "sidebarSelectionCoversNativeBlueWithoutLosingKeyboardNavigation",
    "rowActionsStayClickableAcrossSubmenusAndHideAfterDismissal",
]
NATIVE_POINTER_OUTPUTS = [STARTED + f"◇ Test {name}() started.\n" + PASSED for name in NATIVE_POINTERS]
CI_QUARANTINED_POINTER = "swiftUIExpandedArtifactCloseAndEscapeLeaveTheChatUsable"
CI_NATIVE_POINTERS = [name for name in NATIVE_POINTERS if name != CI_QUARANTINED_POINTER]
CI_QUARANTINE_NOTICE = (f"Skipping {CI_QUARANTINED_POINTER} in CI: "
                        "artifact readiness failed (run 40019119622).\n")
VISUAL_LAYOUT = "longNativeVisualTextReflowsAndShrinksWithoutAnInlineScrollView"
UI_PROBE = "inlineArtifactLayoutKeepsTheReadingColumnWhenResized"
TAIL_OUTPUTS = [STARTED + f"◇ Test {name}() started.\n" + PASSED for name in [VISUAL_LAYOUT, UI_PROBE]]
BROAD_EXCLUSIONS = f"{ISOLATED}|{DEVBOX}|{TERMINAL}|{'|'.join(CALLBACKS)}|{'|'.join(JOURNEYS)}|{'|'.join(SCOPED_MODELS)}|{'|'.join(SCOPED_MODEL_NATIVE)}|{'|'.join(AUTOMATIC_UPDATES)}|{'|'.join(name for group in REGRESSION_PARTITIONS for name in group)}|{'|'.join(NATIVE_POINTERS)}|{VISUAL_LAYOUT}"

# Same partition order as test.sh. One shell run verifies every filter and guard;
# the full fault/missing-start matrix exercises the production parser in-process.
PARTITIONS = [[ISOLATED], [DEVBOX], [TERMINAL], CALLBACKS,
              *[[name] for name in JOURNEYS], SCOPED_MODELS,
              *[[name] for name in SCOPED_MODEL_NATIVE], AUTOMATIC_UPDATES,
              *REGRESSION_PARTITIONS, *[[name] for name in NATIVE_POINTERS], [VISUAL_LAYOUT], [UI_PROBE]]


class TestOutputTests(unittest.TestCase):
    def test_required_partitions_have_swift_definitions(self):
        # Mocked driver output must not conceal a filter left behind by a deleted fixture.
        definitions = set()
        for source in (SCRIPTS.parent / "Tests").rglob("*.swift"):
            definitions.update(re.findall(r"\bfunc\s+(\w+)\s*\(", source.read_text()))
        for names in PARTITIONS:
            for name in names:
                with self.subTest(name=name):
                    self.assertTrue(name in definitions, f"required-start filter has no Swift definition: {name}")

    def test_native_pointer_registry_matches_wrapper(self):
        source = (SCRIPTS / "test.sh").read_text()
        registry = re.search(r"native_pointer_tests=\(\n(.*?)\n\)", source, re.S)
        self.assertIsNotNone(registry)
        names = re.findall(r"^\s*(\w+)\s*$", registry.group(1), re.M)
        self.assertEqual(names, NATIVE_POINTERS)

    def test_artifact_sheet_fixture_keeps_actions_deadlines_and_phase_diagnostics(self):
        # Structural coverage only; the mounted behavior must still pass real macOS CI.
        source = (SCRIPTS.parent / "Tests/PilotUITests/ArtifactPresentationTests.swift").read_text()
        name = "swiftUIExpandedArtifactCloseAndEscapeLeaveTheChatUsable"
        self.assertEqual(sum(names.count(name) for names in PARTITIONS), 1)
        self.assertIn("[false, true, false].enumerated()", source)
        self.assertIn("sheet.performKeyEquivalent(with: event)", source)
        self.assertIn("try #require(handled,", source)
        self.assertNotIn("sheet.sendEvent(event)", source)
        self.assertEqual(source.count("accessibilityPerformPress()"), 2)
        self.assertIn("window.attachedSheet == nil", source)
        self.assertIn("#expect(window.isVisible,", source)
        self.assertIn("window.displayIfNeeded()", source)
        self.assertIn("window.attachedSheet?.displayIfNeeded()", source)
        self.assertIn("0..<150", source)
        self.assertIn("Task.sleep(for: .milliseconds(20))", source)
        self.assertIn("@Test(.timeLimit(.minutes(1)))", source)
        for phase in ["mount card", "attach viewer", "register Close", "dismiss viewer"]:
            self.assertRegex(source, r'settleArtifactSheet\(window, phase: "[^"\n]*' + phase)
        self.assertIn("sourceLocation: sourceLocation", source)
        self.assertIn("artifactSheetDiagnostics(window)", source)
        exercise = source.split("@MainActor private func artifactSheetButton", 1)[0]
        self.assertNotIn("endSheet(", exercise)

    def test_usage_http_fixture_keeps_its_deadline_in_the_scheduler_partition(self):
        source = SCRIPTS.parent / "Tests/PilotUITests/UsageProjectionTests.swift"
        self.assertIn(USAGE_PROJECTION, REGRESSION_PARTITIONS[-1])
        self.assertEqual(sum(names.count(USAGE_PROJECTION) for names in PARTITIONS), 1)
        self.assertRegex(source.read_text(),
                         r"@Test\(\.timeLimit\(\.minutes\(1\)\)\) @MainActor\s+func " + USAGE_PROJECTION)

    def test_retained_history_fixture_keeps_its_required_start(self):
        source = SCRIPTS.parent / "Tests/PilotTests/RetiredDevboxTests.swift"
        self.assertRegex(source.read_text(), r"func " + DEVBOX + r"\(")
        self.assertEqual(sum(names.count(DEVBOX) for names in PARTITIONS), 1)

    def test_automatic_update_partition_covers_production_fixtures(self):
        source = SCRIPTS.parent / "Tests/PilotTests/RetiredDevboxTests.swift"
        self.assertEqual(re.findall(r"@Test @MainActor func (retired(?!Devboxes)\w+)\(", source.read_text()), AUTOMATIC_UPDATES)

    def test_scoped_model_partitions_cover_the_production_fixtures(self):
        scheduler = SCRIPTS.parent / "Tests/PilotTests/LocalModelScopeTests.swift"
        native = SCRIPTS.parent / "Tests/PilotUITests/ScopedModelsInteractionTests.swift"
        transport = SCRIPTS.parent / "Tests/PilotTests/ScopedModelsTransportTests.swift"
        self.assertEqual(re.findall(r"func (localModelScope\w+)\(", scheduler.read_text()) +
                         re.findall(r"func (modelScope\w+)\(", transport.read_text()), SCOPED_MODELS)
        self.assertEqual(re.findall(r"func (scopedModels\w+)\(", native.read_text()), SCOPED_MODEL_NATIVE)

    def check_guard(self, text, names=()):
        output, diagnostics = io.BytesIO(), io.StringIO()
        status = guard.check_output(io.BytesIO(text.encode()), output, diagnostics, names)
        self.assertEqual(output.getvalue(), text.encode())
        return status, diagnostics.getvalue()

    def test_every_partition_rejects_missing_starts_failures_and_incomplete_output(self):
        for names in PARTITIONS:
            output = STARTED + "".join(f"◇ Test {name}() started.\n" for name in names) + PASSED
            self.assertEqual(self.check_guard(output, names), (0, ""))
            cases = ["", PASSED, output + FAILED, output.removesuffix(PASSED),
                     output + "✘ Test fixture() recorded an issue: Expectation failed\n"]
            cases += [output.replace(f"◇ Test {name}() started.\n", "") for name in names]
            for text in cases:
                with self.subTest(names=names, text=text):
                    status, diagnostics = self.check_guard(text, names)
                    self.assertEqual(status, 1)
                    self.assertTrue(diagnostics)

    def test_parser_preserves_non_utf8_output_bytes(self):
        raw = b"warning: \xff\xfe\n" + PASSED.encode()
        output, diagnostics = io.BytesIO(), io.StringIO()
        self.assertEqual(guard.check_output(io.BytesIO(raw), output, diagnostics), 0)
        self.assertEqual(output.getvalue(), raw)
        self.assertEqual(diagnostics.getvalue(), "")

    def test_late_partition_guard_failure_and_driver_failure_stop_the_shell_chain(self):
        # Early failures are covered below; these cover middle and final pipelines.
        for options, expected in [
            ({"automatic_update_outputs": [(AUTOMATIC_UPDATE_OUTPUTS[0] + FAILED, 0)]},
             ["--filter", "|".join(AUTOMATIC_UPDATES)]),
            ({"tail_outputs": [(text, 0) for text in TAIL_OUTPUTS[:-1]] + [(TAIL_OUTPUTS[-1], 42)]},
             ["--filter", "PilotUITests", "--skip", BROAD_EXCLUSIONS]),
            ({"pointer_outputs": [(NATIVE_POINTER_OUTPUTS[0].removesuffix(PASSED), 0)]},
             ["--filter", NATIVE_POINTERS[0]]),
        ]:
            result, continued, calls = self.run_wrapper(PASSED, all_calls=True, **options)
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse(continued)
            self.assertEqual(calls[-1][-len(expected):], expected)

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
                    sixth_output=None, sixth_status=0, seventh_output=None, seventh_status=0,
                    extra_env=None, scoped_model_outputs=None, automatic_update_outputs=None,
                    regression_outputs=None, pointer_outputs=None, tail_outputs=None):
        if sixth_output is None:
            sixth_output = JOURNEY_START_OUTPUT
        if seventh_output is None:
            seventh_output = JOURNEY_SIDEBAR_OUTPUT
        extra_env = extra_env or {}
        # Exercise the actual shell wrapper without downloading/building the app.
        with tempfile.TemporaryDirectory(prefix="swift wrapper ") as directory:
            root = Path(directory)
            scripts = root / "apps/macos/scripts"
            scripts.mkdir(parents=True)
            for name in [wrapper, "check-test-output.py", "check-font-roles.py", "font-literals.txt", "run-swift-tests.py"]:
                shutil.copy2(SCRIPTS / name, scripts / name)
            # Record the real guard's argv, not a replacement guard or fake assertion.
            guard_path = scripts / "check-test-output.py"
            guard_path.write_text(guard_path.read_text().replace(
                "    sys.exit(main())",
                '    import json, os\n'
                '    with open(os.environ["GUARD_ARGUMENTS"], "a") as log:\n'
                '        log.write(json.dumps(sys.argv[1:]) + "\\n")\n'
                '    sys.exit(main())'))
            (scripts / "swift-env.sh").write_text("")
            for name in ["vendor-ghostty.sh", "vendor-mermaidkit.sh", "vendor-quickjs.sh", "share-artifacts.sh"]:
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
                       (sixth_output, sixth_status), (seventh_output, seventh_status)]
            outputs += ([(text, 0) for text in SCOPED_MODEL_OUTPUTS] if scoped_model_outputs is None else scoped_model_outputs)
            outputs += ([(text, 0) for text in AUTOMATIC_UPDATE_OUTPUTS] if automatic_update_outputs is None else automatic_update_outputs)
            outputs += ([(text, 0) for text in REGRESSION_OUTPUTS] if regression_outputs is None else regression_outputs)
            pointer_names = CI_NATIVE_POINTERS if extra_env.get("CI") else NATIVE_POINTERS
            outputs += ([(STARTED + f"◇ Test {name}() started.\n" + PASSED, 0) for name in pointer_names]
                        if pointer_outputs is None else pointer_outputs)
            outputs += ([(text, 0) for text in TAIL_OUTPUTS] if tail_outputs is None else tail_outputs)
            env = {**{key: value for key, value in os.environ.items() if key != "CI"},
                   "PATH": f"{root}:{os.environ['PATH']}",
                   "FAKE_SWIFT": str(root / "swift"), "ARGUMENTS": str(arguments), "PILOT_SWIFT_JOBS": "2",
                   "COUNTER": str(root / "swift-calls"), "GUARD_ARGUMENTS": str(root / "guard-arguments"),
                   "BUNDLE_RUNTIME": "0", **extra_env}
            for index, (text, code) in enumerate(outputs, start=1):
                env[f"OUTPUT_{index}"] = text
                env[f"STATUS_{index}"] = str(code)
            # Use macOS's Bash 3.2, not a newer Homebrew bash picked by env.
            result = subprocess.run(
                ["/bin/bash", "-c", '/bin/bash "$@" && touch "$CONTINUED"', "test", str(scripts / wrapper), *args],
                env={**env, "CONTINUED": str(marker)}, capture_output=True, text=True)
            calls = ([part.splitlines() for part in arguments.read_text().split("__SWIFT_CALL__\n")[1:]]
                     if arguments.exists() else [])
            guard_log = root / "guard-arguments"
            self.guard_calls = [json.loads(line) for line in guard_log.read_text().splitlines()] if guard_log.exists() else []
            return result, marker.exists(), calls if all_calls else calls[-1] if calls else []

    def test_full_suite_runs_window_interactions_separately_without_rebuilding(self):
        result, continued, calls = self.run_wrapper(PASSED, all_calls=True, extra_env={"CI": "true"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)
        self.assertEqual(len(calls), 7 + len(SCOPED_MODEL_OUTPUTS) + len(AUTOMATIC_UPDATE_OUTPUTS) + len(REGRESSION_OUTPUTS) + len(CI_NATIVE_POINTERS) + len(TAIL_OUTPUTS))
        expected_guards = [[], *[names for names in PARTITIONS if names != [CI_QUARANTINED_POINTER]]]
        sampling = self.guard_calls[0][:4]
        self.assertEqual(sampling[:3], ["--sample-stalled-after", "60", "--runner-parent-pid"])
        self.assertGreater(int(sampling[3]), 0)
        self.assertEqual(self.guard_calls,
                         [sampling + [arg for name in names for arg in ("--require-test", name)]
                          for names in expected_guards])
        self.assertEqual(calls[0][-2:],
                         ["--skip", f"{BROAD_EXCLUSIONS}|PilotUITests"])
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
        self.assertEqual(calls[5][-2:], ["--filter", JOURNEYS[0]])
        self.assertIn("--skip-build", calls[6])
        self.assertEqual(calls[6][-2:], ["--filter", JOURNEYS[1]])
        scoped_start = 7
        self.assertEqual(calls[scoped_start][-2:], ["--filter", "|".join(SCOPED_MODELS)])
        self.assertIn("--skip-build", calls[scoped_start])
        for index, name in enumerate(SCOPED_MODEL_NATIVE, start=scoped_start + 1):
            self.assertEqual(calls[index][-2:], ["--filter", name])
            self.assertIn("--skip-build", calls[index])
        for call, names in zip(calls[-len(REGRESSION_PARTITIONS)-len(CI_NATIVE_POINTERS)-2:-len(CI_NATIVE_POINTERS)-2], REGRESSION_PARTITIONS):
            self.assertEqual(call[-2:], ["--filter", "|".join(names)])
            self.assertIn("--skip-build", call)
        for call, name in zip(calls[-len(CI_NATIVE_POINTERS)-2:-2], CI_NATIVE_POINTERS):
            self.assertEqual(call[-2:], ["--filter", name])
            self.assertIn("--skip-build", call)
        self.assertEqual(calls[-2][-2:], ["--filter", VISUAL_LAYOUT])
        self.assertEqual(calls[-1][-4:], ["--filter", "PilotUITests", "--skip", BROAD_EXCLUSIONS])
        for call in calls[-2:]:
            self.assertIn("--skip-build", call)
        timing_lines = re.findall(r"^\[swift-watchdog\] invocation finished in [0-9.]+s\n", result.stdout, re.MULTILINE)
        self.assertEqual(len(timing_lines), len(calls))
        output = re.sub(r"^\[swift-watchdog\] invocation finished in [0-9.]+s\n", "", result.stdout, flags=re.MULTILINE)
        self.assertEqual(output, PASSED + ISOLATED_OUTPUT + DEVBOX_OUTPUT + TERMINAL_OUTPUT + CALLBACKS_OUTPUT
                         + JOURNEY_START_OUTPUT + JOURNEY_SIDEBAR_OUTPUT
                         + "".join(SCOPED_MODEL_OUTPUTS) + "".join(AUTOMATIC_UPDATE_OUTPUTS) + "".join(REGRESSION_OUTPUTS)
                         + CI_QUARANTINE_NOTICE
                         + "".join(STARTED + f"◇ Test {name}() started.\n" + PASSED for name in CI_NATIVE_POINTERS)
                         + "".join(TAIL_OUTPUTS))

    def test_ci_quarantine_preserves_local_required_start_and_explicit_selection(self):
        result, continued, calls = self.run_wrapper(PASSED, all_calls=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)
        self.assertIn(["--filter", CI_QUARANTINED_POINTER], [call[-2:] for call in calls])
        self.assertIn(["--require-test", CI_QUARANTINED_POINTER], self.guard_calls)
        self.assertNotIn(CI_QUARANTINE_NOTICE, result.stdout)
        # Explicit selection stays available even on CI for a deliberate diagnostic run.
        result, continued, calls = self.run_wrapper(
            STARTED + f"◇ Test {CI_QUARANTINED_POINTER}() started.\n" + PASSED,
            args=("--filter", CI_QUARANTINED_POINTER), all_calls=True, extra_env={"CI": "true"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][-2:], ["--filter", CI_QUARANTINED_POINTER])
        self.assertNotIn(CI_QUARANTINE_NOTICE, result.stdout)

    def test_ci_quarantine_does_not_excuse_missing_or_failing_other_pointer_tests(self):
        name = CI_NATIVE_POINTERS[0]
        for output in [PASSED, STARTED + f"◇ Test {name}() started.\n" + FAILED]:
            result, continued, _ = self.run_wrapper(
                PASSED, pointer_outputs=[(output, 0)], extra_env={"CI": "true"})
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse(continued)
            self.assertIn(CI_QUARANTINE_NOTICE, result.stdout)
        self.assertIn("native test target failed", result.stderr)

    def test_isolated_journeys_are_required_only_on_ci(self):
        # Outside CI an empty journey is valid. On CI its required-start guard rejects it.
        result, continued, _ = self.run_wrapper(PASSED, sixth_output=PASSED, seventh_output=PASSED)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(continued)
        for options in [{"sixth_output": PASSED}, {"seventh_output": PASSED}]:
            result, continued, _ = self.run_wrapper(PASSED, extra_env={"CI": "true"}, **options)
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse(continued)

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
        self.assertEqual(len(calls), 7 + len(SCOPED_MODEL_OUTPUTS) + len(AUTOMATIC_UPDATE_OUTPUTS) + len(REGRESSION_OUTPUTS) + len(NATIVE_POINTERS) + len(TAIL_OUTPUTS))
        for call in calls:
            self.assertIn("--jobs=1", call)
            self.assertNotIn("--jobs", call)
            self.assertEqual(call.count("--skip-build"), 1)

    def test_all_swift_entrypoints_stop_when_package_preparation_fails(self):
        for wrapper in ["build.sh", "test.sh", "bundle.sh"]:
            with self.subTest(wrapper=wrapper):
                result, continued, _ = self.run_wrapper("", wrapper=wrapper, prepare_status=42)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertFalse(continued)

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
            shutil.copy2(SCRIPTS.parent / "Tests/NativeTestSupport/TestMainLoop.swift",
                         root / "Tests/PassingTests/TestMainLoop.swift")
            swift = subprocess.check_output(["xcrun", "--find", "swift"], text=True).strip()
            plugins = str(Path(swift).parent / "../lib/swift/host/plugins/testing")
            for fail in ["1", "0"]:
                result = subprocess.run(
                    ["swift", "test", "--package-path", str(root), "--build-system", "native", "--jobs", "2",
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
