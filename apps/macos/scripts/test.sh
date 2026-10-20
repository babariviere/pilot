#!/usr/bin/env bash
# Command Line Tools ship Swift Testing's macro plugin outside the default plugin path.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# Hold the slot through package resolution, compilation and every test runner.
if [ "${PILOT_VERIFICATION_SWIFT_PID:-}" != "$$" ]; then
	exec python3 "$here/../../scripts/verification-slot.py" swift -- "$BASH" "$0" "$@"
fi
unset PILOT_VERIFICATION_SWIFT_PID
# Chrome text stays on the Theme.TextRole scale; fails fast on new fixed font sizes or text styles.
python3 "$here/scripts/check-font-roles.py"
# shellcheck source=swift-env.sh
source "$here/scripts/swift-env.sh"
"$here/scripts/vendor-ghostty.sh"
"$here/scripts/vendor-mermaidkit.sh"
"$here/scripts/vendor-quickjs.sh"
"$here/scripts/share-artifacts.sh"
plugins="$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
# Multiple agents can verify concurrently. Avoid each one consuming every available CPU.
jobs=(--jobs "${PILOT_SWIFT_JOBS:-2}")
for argument in "$@"; do
	case "$argument" in --jobs|--jobs=*|-j|-j[0-9]*) jobs=();; esac
done
# CLT 27 can return 0 when an earlier test target failed and a later one passed.
# The output guard checks each started runner's terminal summary and recorded
# failures, not just SwiftPM's aggregate exit status. pipefail also preserves
# build failures, crashes and other nonzero driver exits.
# Bash 3.2 (macOS /bin/bash) treats an empty array as unset under nounset.
# Native window interaction and this WebKit matrix must not compete with hundreds
# of unrelated MainActor tests and their nested AppKit run loops. Keep their
# assertions and time limits, running each in its own process with the same build.
isolated=artifactHeightRespectsNestedClippingWhileKeepingVisibleOverflow
devbox=addDevboxPresentsSetupSheetAfterCancelAndReopen
terminal=terminalOpeningAndResizingDoNotFeedNativeFittingSizeBackIntoWindowConstraints
callbacks='localStopNormalizesQualifiedRowsAndRestoresWithdrawnMessages|remoteStopKeepsCollidingLocalChatAndDraftUntouched|unavailableStopNeverFallsBackToCurrentLocalHost|unknownStopIsRejectedBeforeDispatchWithoutLocalFallback|missionTaskDragLoadsItsPlainTextOnTheMainActor'
# Each journey activates NSApp's process-global key window and pumps nested main run loops. Keep them in separate
# processes so Swift Testing cannot interleave the journeys at those yields and let one take focus from the other.
# They run only on CI, so only CI requires them to start.
journeyStart=keyboardOnlyStartSwitchTypeAndReturn
journeySidebar=keyboardOnlySidebarBrowsingKeepsFocusInTheSidebar
journeys="$journeyStart|$journeySidebar"
# These native approval controls also own AppKit mouse tracking. Run each alone, keeping its deadline.
github='githubKeySheetRequiresNativeConfirmationAndCancelDoesNotRegister|githubExistingCheckoutRequiresExplicitNativeReuseConfirmation|githubImportNativeCloneActionStaysDisabledUntilHostDestinationPreview'
# Scoped-model scheduler waits need the MainActor, but no AppKit run loops. Keep
# their bounded fault fixtures together, separate from both the full suite and native clicks.
scoped_model_tests=(
	scopedModelsNoStartupWritesAndLocalFirstIndependentHosts
	scopedModelsOfflineColdLaunchAndNewIdentityNeedExplicitConsent
	scopedModelsLostAckExactReadbackAndOnlyOneBoundedRetryAcrossRelaunch
	scopedModelsConflictChoicesNeverBlindlyRebaseOtherHosts
	scopedModelsSupersededRevisionAndGenerationCannotPublishOldSuccess
	scopedModelsCoalescesSavesWithoutCallingOlderReadbackNewSuccess
	scopedModelsLeaveDuringAcceptedWritePersistsWithoutLateSuccessRevivingSync
	scopedModelsReadOnlyAndUnavailablePatternsAreTruthfulAndDurable
	scopedModelsBoundsIndependentHostConcurrency
	scopedModelsConflictConsentCannotFollowNewIntentOrConnection
	scopedModelsReadFailureCannotErasePersistedLeaveAsIs
	modelScopeLiveOwnerSyncsLocalAndTwoDevboxesAcrossOfflineReconnectAndRelaunch
	modelScopeLiveConflictAndLeaveRemainDivergentAfterColdLaunch
	modelScopeWirePreservesAllAndDecodesBothPutArmsWithoutCapabilityReadsOnGet
	modelScopeWireRejectsStaleCapabilityAcquisitionBeforeSending
	modelScopeWireExposesTypedReadFailuresWithoutTreatingThemAsAbsent
	modelScopeWireReconcilesCommitted503WithLiteralReadbackWithoutRepeatingPut
)
printf -v scoped_models '%s|' "${scoped_model_tests[@]}"
scoped_models="${scoped_models%|}"
scoped_model_native='scopedModelsNativeSavePersistsAndDispatchesExplicitAllOnlyAfterClick|scopedModelsNativeSelectorPreservesAdvancedPatterns|scopedModelsNativeSaveUsesHostOwnerCapabilityHttpAndLiteralReadback'
# Update/store fault fixtures need MainActor scheduling, not native window run loops.
automatic_update_tests=(
	automaticPackageWaitersCancelIndependentlyAndReconnectDoesNotWaitForAbandonedIO
	automaticStoreKeepsEveryCancelledTargetAndRefusesUnresolvedReplay
	automaticLiveStartupKeepsLocalUnblockedAndUsesTheVerifiedRuntimeOwner
	automaticOlderRuntimeStagesOnceAndSharesWaitingBlockersWithoutSettings
	automaticSameNewerUnknownAndUnsupportedVersionsNeverDownloadOrDowngrade
	automaticLostAckAndRelaunchLookUpOriginalManualOrAutomaticIntentOnly
	automaticPendingDifferentPackageAndUnknownAckCannotAllocateReplacement
	automaticUnreadableStoreAndNeedsRepairFailClosedWithoutReplacingState
	automaticIdentityReplacementCannotPublishOldSuccessOrSendAnotherRequest
	automaticCancellationSurvivesLostAckReconnectAndColdLaunchUntilExplicitRetry
	automaticTrustFailureIsBoundedAndCannotCreateAnIntent
	automaticDisconnectOrTargetChangeDuringDownloadCannotDispatchStalePackage
	automaticWorkIsBoundedAndOneHostDoesNotBlockOthersOrInventTermination
)
printf -v automatic_updates '%s|' "${automatic_update_tests[@]}"
automatic_updates="${automatic_updates%|}"
# Host-specific HTTP fault fixtures need MainActor scheduling, not AppKit event loops.
mcp_tests=(
	hostMcpRosterCoalescesUnchangedPresentationWithoutStartingChecks
	hostMcpActionsRouteDuplicateNamesAndCancelToTheExactHost
	hostMcpReviewedSetupUsesHostCapabilitiesAndReconcilesCommitted503WithoutReplay
	hostMcpSourceAndTargetEditsOrExistingNamespacesRequireNewReview
	hostMcpDisconnectDuringCapabilityReadCannotDispatchToReplacement
	hostMcpUncertainApplyOnlyLooksUpTheSamePinAfterReconnect
	hostMcpNativeProjectionRejectsSecretsAndLocalPaths
	hostMcpDelayedResultsAndReplacementPinsCannotPublishOrRetarget
	hostMcpAdditiveReviewKeepsOtherServersAndLabelsNamespacesWithoutReplacingThem
	hostMcpNativeCheckboxSelectsOnlyMissingServers
)
printf -v host_mcps '%s|' "${mcp_tests[@]}"
host_mcps="${host_mcps%|}"
# Mounted repair history and settings exercise native layout/run loops. Keep them
# apart from each other and from scheduler tests whose deadlines/cache TTLs keep
# elapsing while unrelated MainActor work is running. Preserve every assertion.
repair_footer='productionFooterStaysFixedWhileReadingLongHistoryAndKeepsTheComposer|questionWorkingPendingAndErrorTransitionsLeaveTheFooterReachable|originalPendingStartRemainsCheckableWithoutAProposalAndOfflineActionsStayDisabled'
settings_bar=settingsSaveBarMountsForDirtyFormAndLeavesAfterRevert
scheduler_regressions='visualSliderDragsCoalesceToOneHandlerInFlightEndingAtTheLastPosition|visualDiscreteEventsRunInOrder|missionNavigationAndPaletteKeepCanonicalPinsAcrossExecutionChangesAndReconnect|sidebarPollsOnlyBranchesAndLoadsCountsOnDemand'
# Synthetic pointer tracking pumps nested AppKit loops. Another fixture can order/close
# a window during that loop and steal the event. Give each real-input test its own process.
native_pointer_tests=(
	diagnoseSetupSubmitsReasonOrBlankThroughMountedControls
	diagnoseReasonBoundsApplyToButtonAndKeyboardAndCancelStartsNothing
	diagnoseStartErrorKeepsReasonForKeyboardRetryAndAskStillSubmits
	nativeControlsActivateOnlyEnabledProductionActions
	nativeRepairPromptButtonsOnlyReviewOrDismissAndNeverSpawn
	mountedDiagnosticsFooterSubmitsOnceAndNeverStartsRepair
	mountedDiagnosticsFooterReviewsAnExistingProposalWithoutStartingWork
	nativeIndependentLocalButtonWorksWhileOriginalCheckIsInProgress
	pressingNativeHomeCheckActuallyChecksShowsProgressAndOpensTheExistingChat
	slackTriageRefreshIsClickableAndDisablesDuringLocalAndAutomaticSync
	sidebarSelectionCoversNativeBlueWithoutLosingKeyboardNavigation
)
printf -v native_pointers '%s|' "${native_pointer_tests[@]}"
native_pointers="${native_pointers%|}"
# SwiftPM drivers can combine test targets in one binary or launch separate
# binaries. Preserve the UI/scheduler boundary regardless of the build driver.
visual_layout=longNativeVisualTextReflowsAndShrinksWithoutAnInlineScrollView
ui_probe=inlineArtifactLayoutKeepsTheReadingColumnWhenResized
broad_exclusions="$isolated|$devbox|$terminal|$callbacks|$journeys|$github|$scoped_models|$scoped_model_native|$automatic_updates|$host_mcps|$repair_footer|$settings_bar|$scheduler_regressions|$native_pointers|$visual_layout"
partition=1
reuse=(--skip-build)
for argument in "$@"; do
	case "$argument" in
		--skip-build) reuse=() ;;
		--filter|--filter=*|--skip|--skip=*|--list-tests|--list-tests=*|-l|list|--version|--help|-h|--show-codecov-path)
			partition=0 ;;
	esac
done
run_tests() {
	local required="$1"
	shift
	local guards=()
	local required_tests=()
	local name
	if [ -n "$required" ]; then
		IFS='|' read -r -a required_tests <<< "$required"
		for name in "${required_tests[@]}"; do guards+=(--require-test "$name"); done
	fi
	swift test --package-path "$here" ${jobs[@]+"${jobs[@]}"} -Xswiftc -plugin-path -Xswiftc "$plugins" "$@" 2>&1 \
		| python3 "$here/scripts/check-test-output.py" ${guards[@]+"${guards[@]}"}
}
if [ "$partition" = 1 ]; then
	run_tests "" "$@" --skip "$broad_exclusions|PilotUITests"
	run_tests "$isolated" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$isolated"
	run_tests "$devbox" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$devbox"
	run_tests "$terminal" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$terminal"
	# Stop and drag-data callbacks keep their MainActor deadlines without competing with UI run loops.
	run_tests "$callbacks" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$callbacks"
	run_tests "${CI:+$journeyStart}" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$journeyStart"
	run_tests "${CI:+$journeySidebar}" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$journeySidebar"
	IFS='|' read -r -a github_tests <<< "$github"
	for name in "${github_tests[@]}"; do
		run_tests "$name" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$name"
	done
	run_tests "$scoped_models" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$scoped_models"
	IFS='|' read -r -a scoped_model_native_tests <<< "$scoped_model_native"
	for name in "${scoped_model_native_tests[@]}"; do
		run_tests "$name" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$name"
	done
	run_tests "$automatic_updates" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$automatic_updates"
	run_tests "$host_mcps" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$host_mcps"
	run_tests "$repair_footer" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$repair_footer"
	run_tests "$settings_bar" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$settings_bar"
	run_tests "$scheduler_regressions" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$scheduler_regressions"
	for name in "${native_pointer_tests[@]}"; do
		run_tests "$name" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$name"
	done
	# Native visual reflow also pumps nested layout/run loops. Keep its existing deadline.
	run_tests "$visual_layout" ${reuse[@]+"${reuse[@]}"} "$@" --filter "$visual_layout"
	run_tests "$ui_probe" ${reuse[@]+"${reuse[@]}"} "$@" --filter PilotUITests --skip "$broad_exclusions"
else
	# Explicit selection/listing is the caller's scope. Do not append another filter.
	run_tests "" "$@"
fi
