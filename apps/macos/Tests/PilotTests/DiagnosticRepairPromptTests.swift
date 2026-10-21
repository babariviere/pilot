import AppKit
import NativeTestSupport
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private let repairLocalHost = HostRef(hostId: "local", daemonId: "local-daemon", lineageId: "local-lineage")
private let repairRemoteHost = HostRef(hostId: "devbox", daemonId: "remote-daemon", lineageId: "remote-lineage")
private let repairTargetID = "00000000-0000-4000-8000-000000000101"
private let repairSpecialistID = "00000000-0000-4000-8000-000000000102"

/// Locate production controls without depending on SwiftUI's backing NSButtons or headless accessibility tree.
@MainActor private func mountedButtons(_ view: NSView) -> [DiagnosticRepairActionAnchorView] {
    NativeInput.views(in: view, of: DiagnosticRepairActionAnchorView.self)
}

private func repairProposal(_ id: String = "diagnostic-proposal:v1:000000000000000000000001")
    -> DiagnosticRepairProposal {
    DiagnosticRepairProposal(id: id, targetSessionId: repairTargetID, createdAt: "2026-10-18T18:00:00.000Z",
                             evidenceRefs: ["diagnostic:v1:lifecycle:one"],
                             findings: "The worker stopped before committing completion.", uncertainty: .medium,
                             suggestedRepair: "Preserve completion until worker supervision settles.",
                             regressionTestGuidance: "Cover the supervised exit boundary.")
}

private func repairSession(host: HostRef = repairLocalHost, proposal: DiagnosticRepairProposal? = repairProposal(),
                           targetControl: Bool = false, specialistState: String = "idle",
                           specialistUpdatedAt: Double = 2) -> (specialist: SessionSummary, target: SessionSummary) {
    var target = SessionSummary(id: repairTargetID, title: targetControl ? "Control" : "Target", cwd: "/tmp",
                                projectId: targetControl ? nil : "project", createdAt: 1, updatedAt: 1,
                                state: "idle")
    target.control = targetControl ? true : nil
    let reference = DiagnosticTargetReference(host: host, sessionId: repairTargetID)!
    let specialist = SessionSummary(id: repairSpecialistID, title: "Diagnostics", cwd: "/tmp",
                                    projectId: targetControl ? nil : "project", createdAt: 2,
                                    updatedAt: specialistUpdatedAt, state: specialistState,
                                    mode: .ask, role: .diagnostics,
                                    diagnosticTargetId: repairTargetID, diagnosticTarget: reference,
                                    diagnosticRepairProposal: proposal)
    return (specialist, target)
}

@Test func publishedRepairProposalBecomesPromptButNeverDisplacesLiveAskOrStartsWork() {
    let fixture = repairSession()
    let visible = DiagnosticRepair.prompt(specialist: fixture.specialist, specialistHost: repairLocalHost,
                                          admittedTarget: fixture.target, available: true,
                                          dismissedProposalId: nil, pendingProposalId: nil,
                                          hasLiveQuestion: false, working: false)
    #expect(visible?.proposal == repairProposal())
    #expect(visible?.primaryTitle == "Review repair…")
    #expect(DiagnosticRepair.prompt(specialist: fixture.specialist, specialistHost: repairLocalHost,
                                    admittedTarget: fixture.target, available: true,
                                    dismissedProposalId: nil, pendingProposalId: nil,
                                    hasLiveQuestion: true, working: false) == nil)
    #expect(DiagnosticRepair.prompt(specialist: fixture.specialist, specialistHost: repairLocalHost,
                                    admittedTarget: fixture.target, available: true,
                                    dismissedProposalId: nil, pendingProposalId: nil,
                                    hasLiveQuestion: false, working: true) == nil)
}

@Test func dismissalIsProposalSpecificAndPendingStartOverridesItForRecovery() throws {
    let first = repairProposal()
    let fixture = repairSession(proposal: first)
    #expect(DiagnosticRepair.prompt(specialist: fixture.specialist, specialistHost: repairLocalHost,
                                    admittedTarget: fixture.target, available: true,
                                    dismissedProposalId: first.id, pendingProposalId: nil,
                                    hasLiveQuestion: false, working: false) == nil)
    let pending = try #require(DiagnosticRepair.prompt(
        specialist: fixture.specialist, specialistHost: repairLocalHost, admittedTarget: fixture.target,
        available: true, dismissedProposalId: first.id, pendingProposalId: first.id,
        hasLiveQuestion: false, working: false
    ))
    #expect(pending.pendingStart && pending.primaryTitle == "Check repair start…")

    let replacement = repairProposal("diagnostic-proposal:v1:000000000000000000000002")
    let replaced = repairSession(proposal: replacement)
    let next = DiagnosticRepair.prompt(specialist: replaced.specialist, specialistHost: repairLocalHost,
                                       admittedTarget: replaced.target, available: true,
                                       dismissedProposalId: first.id, pendingProposalId: first.id,
                                       hasLiveQuestion: false, working: false)
    #expect(next?.proposal == replacement && next?.pendingReplacement == true)
}

@Test @MainActor func dismissalPersistsAcrossModelsAndContextActionStillReopensReview() throws {
    let suite = "DiagnosticRepairPromptTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let reference = HostResourceRef(host: repairLocalHost, kind: .session, localId: repairSpecialistID)
    let first = AppModel(projectFolderDefaults: defaults, client: PilotClient())
    try first.registerLocal(repairLocalHost)
    first.dismissDiagnosticRepairProposal(repairProposal().id, for: reference)
    let reopened = AppModel(projectFolderDefaults: defaults, client: PilotClient())
    try reopened.registerLocal(repairLocalHost)
    #expect(reopened.dismissedDiagnosticRepairProposal(for: reference) == repairProposal().id)
    let fixture = repairSession()
    reopened.prepareDiagnosticRepair(fixture.specialist, context: nil)
    #expect(reopened.diagnosticRepairTarget?.reference == reference,
            "the context action directly reopens review without clearing persisted Not now")
}

@Test func verifiedHostAndTargetStayRequiredForLocalDevboxAndControlProposals() {
    for (host, control) in [(repairLocalHost, false), (repairRemoteHost, false), (repairLocalHost, true)] {
        let fixture = repairSession(host: host, targetControl: control)
        let prompt = DiagnosticRepair.prompt(specialist: fixture.specialist, specialistHost: host,
                                             admittedTarget: fixture.target, available: true,
                                             dismissedProposalId: nil, pendingProposalId: nil,
                                             hasLiveQuestion: false, working: false)
        #expect(prompt?.problem == nil)
    }
    let fixture = repairSession(host: repairRemoteHost)
    let wrongHost = DiagnosticRepair.prompt(specialist: fixture.specialist, specialistHost: repairLocalHost,
                                            admittedTarget: fixture.target, available: true,
                                            dismissedProposalId: nil, pendingProposalId: nil,
                                            hasLiveQuestion: false, working: false)
    #expect(wrongHost?.problem?.contains("different host identity") == true)
}

@Test func reviewedHandoffCreatesOnlyAnOrdinaryBuildWithExactProposalAuthority() throws {
    let fixture = repairSession()
    let proposal = try #require(fixture.specialist.diagnosticRepairProposal)
    let admission = try DiagnosticRepair.admission(specialist: fixture.specialist,
        specialistHost: repairLocalHost, proposal: proposal,
        binding: DiagnosticRepairProjectBinding(id: "00000000-0000-4000-8000-000000000009", revision: 1,
            host: repairLocalHost, projectId: "pilot-source", path: "/sources/pilot", configuredAt: "2026-10-19T00:00:00Z"))
    let handoffJSON = """
    {
      "schemaVersion": 1,
      "host": {"hostId":"local","daemonId":"local-daemon","lineageId":"local-lineage"},
      "targetSessionId": "\(repairTargetID)",
      "projectId": "project",
      "evidence": [],
      "proposalId": "\(proposal.id)",
      "findings": "Bounded finding",
      "uncertainty": "medium",
      "suggestedRepair": "Bounded repair",
      "regressionTestGuidance": "Bounded regression"
    }
    """
    let handoff = try JSONDecoder().decode(DiagnosticsHandoff.self, from: Data(handoffJSON.utf8))
    let request = try DiagnosticRepair.spawnRequest(handoff: handoff, destinationProjectId: "pilot-source",
                                                    admission: admission)
    #expect(request.mode == .build && request.role == nil)
    #expect(request.diagnosticRepair == admission)
    #expect(request.diagnosticTarget == nil && request.diagnosticHistoryAccess == nil)
    #expect(request.diagnosticRepair?.readDiagnostics == nil)
    #expect(request.message.contains("No fresh diagnostic access was granted"))
    let granted = try DiagnosticRepair.admission(specialist: fixture.specialist,
        specialistHost: repairLocalHost, proposal: proposal, binding: admission.binding, readDiagnostics: true)
    let grantedRequest = try DiagnosticRepair.spawnRequest(handoff: handoff, destinationProjectId: "pilot-source",
        admission: granted)
    #expect(grantedRequest.diagnosticRepair?.readDiagnostics == true)
    #expect(grantedRequest.message.contains("approved subject and host only"))
    #expect(grantedRequest.message.contains("Do not inspect other chats or switch hosts"))
    #expect(grantedRequest.role == nil && grantedRequest.diagnosticTarget == nil)
    let bytes = try JSONEncoder().encode(grantedRequest)
    let restored = try JSONDecoder().decode(SpawnRequest.self, from: bytes)
    #expect(restored.diagnosticRepair?.readDiagnostics == true)
    let declined = try DiagnosticRepair.admission(specialist: fixture.specialist,
        specialistHost: repairLocalHost, proposal: proposal, binding: admission.binding, readDiagnostics: false)
    #expect(declined.readDiagnostics == false)
}

@Test @MainActor func uncertainRepairStartReusesOneDurableIntentAndBlocksAChangedDuplicate() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let hosts = HostClients(operationDirectory: directory)
    let client = PilotClient()
    let fixture = repairSession()
    client.loadFixture(projects: [], sessions: [fixture.specialist, fixture.target])
    try hosts.install(client, host: repairLocalHost)
    let suite = "DiagnosticRepairAdmissionTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let app = AppModel(projectFolderDefaults: defaults, client: client, hosts: hosts)
    try app.registerLocal(repairLocalHost)
    let proposal = try #require(fixture.specialist.diagnosticRepairProposal)
    let admission = try DiagnosticRepair.admission(specialist: fixture.specialist,
                                                   specialistHost: repairLocalHost, proposal: proposal)
    let request = SpawnRequest(projectId: "project", message: "Reviewed repair", mode: .build,
                               diagnosticRepair: admission)
    let first = try await hosts.deliver(host: repairLocalHost, kind: "repair-create", targetId: nil,
                                        payload: request, origin: repairLocalHost)
    let duplicate = try await hosts.deliver(host: repairLocalHost, kind: "repair-create", targetId: nil,
                                            payload: request, origin: repairLocalHost)
    #expect(first.0 == duplicate.0, "the same confirmed payload reserves one immutable operation")
    #expect(hosts.pendingOperations.count == 1)
    let target = DiagnosticRepairTarget(specialist: fixture.specialist,
        reference: HostResourceRef(host: repairLocalHost, kind: .session, localId: repairSpecialistID))
    await #expect(throws: ClientError.self) {
        _ = try await app.startDiagnosticRepair(
            SpawnRequest(projectId: "project", message: "Changed repair", model: "other/model", mode: .build,
                         diagnosticRepair: admission),
            target: target
        )
    }
    #expect(hosts.pendingOperations.count == 1, "uncertain delivery never authorizes a fresh operation")
}

@Test @MainActor func nativeRepairPromptButtonsOnlyReviewOrDismissAndNeverSpawn() async throws {
    _ = NSApplication.shared
    let client = PilotClient()
    client.loadFixture(projects: [], sessions: [])
    let fixture = repairSession()
    let presentation = try #require(DiagnosticRepair.prompt(
        specialist: fixture.specialist, specialistHost: repairLocalHost, admittedTarget: fixture.target,
        available: true, dismissedProposalId: nil, pendingProposalId: nil,
        hasLiveQuestion: false, working: false
    ))
    var reviews = 0
    var dismissals = 0
    let prompt = DiagnosticRepairPrompt(presentation: presentation,
                                        onReview: { reviews += 1 }, onDismiss: { dismissals += 1 })
    let hosting = NSHostingView(rootView: prompt)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 420),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
    window.orderFrontRegardless(); window.update(); hosting.layoutSubtreeIfNeeded()
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while mountedButtons(hosting).count < 2, ContinuousClock.now < deadline {
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(20))
    }
    let controls = mountedButtons(hosting)
    try #require(controls.count == 2, "the production proposal tray has only Review and Not now actions")
    for control in controls { try await NativeInput.click(control) }
    #expect(reviews == 1 && dismissals == 1)
    #expect(client.fixtureSpawnRequests.isEmpty, "viewing, reviewing and dismissing the tray never starts a chat")
}

@Test func diagnosticsRolePresentationReplacesGenericAskWithoutChangingReadOnlyMode() throws {
    for (host, control) in [(repairLocalHost, false), (repairRemoteHost, false), (repairLocalHost, true)] {
        let fixture = repairSession(host: host, proposal: nil, targetControl: control)
        let segments = RowLineSegments.session(fixture.specialist, projectName: control ? nil : "Pilot")
        #expect(segments.contains { $0.kind == .diagnostics })
        #expect(!segments.contains { if case .ask = $0.kind { true } else { false } })
        #expect(fixture.specialist.isAsk && fixture.specialist.isDiagnosticsSpecialist)
        let presentation = DiagnosticRepair.headerPresentation(
            specialist: fixture.specialist, specialistHost: host, admittedTarget: fixture.target,
            available: true, destinationAvailable: true, request: nil
        )
        #expect(presentation.title == "Suggest a repair" && presentation.enabled)
    }

    let proposed = repairSession()
    let review = DiagnosticRepair.headerPresentation(
        specialist: proposed.specialist, specialistHost: repairLocalHost, admittedTarget: proposed.target,
        available: true, destinationAvailable: true, request: nil
    )
    #expect(review.action == .review && review.title == "Review repair" && review.enabled)

    let ordinaryAsk = SessionSummary(id: "ask", title: "Ask", cwd: "/tmp", createdAt: 1, updatedAt: 1,
                                     state: "idle", mode: .ask, sourceBranch: "main")
    let ordinaryBuild = SessionSummary(id: "build", title: "Build", cwd: "/tmp", branch: "main",
                                       createdAt: 1, updatedAt: 1, state: "idle")
    #expect(RowLineSegments.session(ordinaryAsk)[0].kind == .ask(source: "origin/main"))
    #expect(RowLineSegments.session(ordinaryBuild, branch: "main")[0].kind == .branch("main"))
}

@Test func diagnosticRepairHeaderExplainsUnavailableTargetsWithoutFallback() {
    let fixture = repairSession(proposal: nil)
    let disconnected = DiagnosticRepair.headerPresentation(
        specialist: fixture.specialist, specialistHost: repairLocalHost, admittedTarget: fixture.target,
        available: false, destinationAvailable: true, request: nil
    )
    #expect(disconnected.title == "Suggest a repair" && !disconnected.enabled)
    #expect(disconnected.detail?.contains("Reconnect") == true)

    let proposed = repairSession()
    let missingDestination = DiagnosticRepair.headerPresentation(
        specialist: proposed.specialist, specialistHost: repairLocalHost, admittedTarget: proposed.target,
        available: true, destinationAvailable: false, request: nil
    )
    #expect(missingDestination.title == "Review repair" && missingDestination.enabled,
            "review can explain setup without granting permission to start")
    #expect(missingDestination.detail?.contains("project") == true)
}

@Test @MainActor func proposalRequestUsesBusyQueueFailureAndExplicitRetryState() async throws {
    let client = PilotClient()
    let fixture = repairSession(proposal: nil, specialistState: "working")
    client.loadFixture(projects: [], sessions: [fixture.specialist, fixture.target])
    let app = AppModel(client: client)
    try app.registerLocal(repairLocalHost)
    let reference = HostResourceRef(host: repairLocalHost, kind: .session, localId: fixture.specialist.id)
    let target = DiagnosticRepairTarget(specialist: fixture.specialist, reference: reference)

    try await app.requestDiagnosticRepairProposal(target)
    var state = try #require(app.diagnosticRepairRequest(for: reference))
    #expect(state.phase == .queued && state.queuedBehindWork && state.observedWorking)
    #expect(client.fixtureSendRequests.count == 1)

    let settled = repairSession(proposal: nil, specialistState: "idle", specialistUpdatedAt: 3)
    client.loadFixture(projects: [], sessions: [settled.specialist, settled.target])
    app.reconcileDiagnosticRepairRequest(settled.specialist, reference: reference)
    state = try #require(app.diagnosticRepairRequest(for: reference))
    #expect(state.phase == .failed)
    #expect(state.error?.contains("without publishing") == true)

    try await app.requestDiagnosticRepairProposal(target)
    #expect(client.fixtureSendRequests.count == 2, "retry is a new request only after the previous turn settled")
    #expect(client.fixtureSpawnRequests.isEmpty)
}

@Test @MainActor func hostQualifiedProposalStateDoesNotFollowNavigationOrAnotherHost() throws {
    let app = AppModel()
    let local = HostResourceRef(host: repairLocalHost, kind: .session, localId: repairSpecialistID)
    let remote = HostResourceRef(host: repairRemoteHost, kind: .session, localId: repairSpecialistID)
    let localFixture = repairSession(host: repairLocalHost, proposal: nil)
    let remoteFixture = repairSession(host: repairRemoteHost, proposal: nil)
    let localTarget = try #require(localFixture.specialist.diagnosticTarget)
    let remoteTarget = try #require(remoteFixture.specialist.diagnosticTarget)
    app.diagnosticRepairRequests[local.storageKey] = DiagnosticRepairRequestState(
        revision: UUID(), target: .chat(localTarget), sessionUpdatedAt: 1, queuedBehindWork: false,
        phase: .queued, observedWorking: false, error: nil, operation: nil
    )
    let remoteState = DiagnosticRepairRequestState(
        revision: UUID(), target: .chat(remoteTarget), sessionUpdatedAt: 1, queuedBehindWork: true,
        phase: .queued, observedWorking: true, error: nil, operation: nil
    )
    app.diagnosticRepairRequests[remote.storageKey] = remoteState

    app.selectedSessionId = "another-chat"
    let completedLocal = repairSession(host: repairLocalHost).specialist
    app.reconcileDiagnosticRepairRequest(completedLocal, reference: local)
    #expect(app.diagnosticRepairRequest(for: local) == nil)
    #expect(app.diagnosticRepairRequest(for: remote) == remoteState,
            "a late result is fenced to its original host and specialist")
}

@Test @MainActor func mountedDiagnosticsFooterSubmitsOnceAndNeverStartsRepair() async throws {
    _ = NSApplication.shared
    let client = PilotClient()
    let fixture = repairSession(proposal: nil)
    client.loadFixture(projects: [], sessions: [fixture.specialist, fixture.target])
    let app = AppModel(client: client)
    try app.registerLocal(repairLocalHost)
    let header = DiagnosticRepairFooter(session: fixture.specialist, context: nil, client: client)
        .environmentObject(app)
    let hosting = NSHostingView(rootView: header)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 180),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
    window.orderFrontRegardless(); window.update(); hosting.layoutSubtreeIfNeeded()

    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while mountedButtons(hosting).isEmpty, ContinuousClock.now < deadline {
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(20))
    }
    let controls = mountedButtons(hosting)
    try #require(controls.count == 1, "the production diagnostics footer has one repair action")
    let action = controls[0]
    try await NativeInput.click(action)
    try await NativeInput.click(action)
    while client.fixtureSendRequests.isEmpty, ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(client.fixtureSendRequests.count == 1, "duplicate clicks admit only one proposal request")
    #expect(client.fixtureSendRequests.first?.mode == .followUp)
    #expect(client.fixtureSendRequests.first?.message.contains("repair_proposal") == true)
    #expect(app.diagnosticRepairTarget == nil, "Suggest does not open an empty manual proposal sheet")
    #expect(client.fixtureSpawnRequests.isEmpty, "Suggest never starts a Build chat")
}

@Test @MainActor func mountedDiagnosticsFooterReviewsAnExistingProposalWithoutStartingWork() async throws {
    _ = NSApplication.shared
    let client = PilotClient()
    let fixture = repairSession()
    client.loadFixture(projects: [Project(id: "project", name: "Pilot", path: "/tmp", createdAt: 1)],
                       sessions: [fixture.specialist, fixture.target])
    let app = AppModel(client: client)
    try app.registerLocal(repairLocalHost)
    let hosting = NSHostingView(rootView:
        DiagnosticRepairFooter(session: fixture.specialist, context: nil, client: client)
            .environmentObject(app))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 180),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
    window.orderFrontRegardless(); window.update(); hosting.layoutSubtreeIfNeeded()
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while mountedButtons(hosting).isEmpty, ContinuousClock.now < deadline {
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(20))
    }
    let controls = mountedButtons(hosting)
    try #require(controls.count == 1, "the production diagnostics footer has one repair action")
    try await NativeInput.click(controls[0])
    #expect(app.diagnosticRepairTarget?.reference.localId == fixture.specialist.id)
    #expect(client.fixtureSendRequests.isEmpty && client.fixtureSpawnRequests.isEmpty)
}
