import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private let repairLocalHost = HostRef(hostId: "local", daemonId: "local-daemon", lineageId: "local-lineage")
private let repairRemoteHost = HostRef(hostId: "devbox", daemonId: "remote-daemon", lineageId: "remote-lineage")
private let repairTargetID = "00000000-0000-4000-8000-000000000101"
private let repairSpecialistID = "00000000-0000-4000-8000-000000000102"

private func repairProposal(_ id: String = "diagnostic-proposal:v1:000000000000000000000001")
    -> DiagnosticRepairProposal {
    DiagnosticRepairProposal(id: id, targetSessionId: repairTargetID, createdAt: "2026-10-18T18:00:00.000Z",
                             evidenceRefs: ["diagnostic:v1:lifecycle:one"],
                             findings: "The worker stopped before committing completion.", uncertainty: .medium,
                             suggestedRepair: "Preserve completion until worker supervision settles.",
                             regressionTestGuidance: "Cover the supervised exit boundary.")
}

private func repairSession(host: HostRef = repairLocalHost, proposal: DiagnosticRepairProposal? = repairProposal(),
                           targetControl: Bool = false) -> (specialist: SessionSummary, target: SessionSummary) {
    var target = SessionSummary(id: repairTargetID, title: targetControl ? "Control" : "Target", cwd: "/tmp",
                                projectId: targetControl ? nil : "project", createdAt: 1, updatedAt: 1,
                                state: "idle")
    target.control = targetControl ? true : nil
    let reference = DiagnosticTargetReference(host: host, sessionId: repairTargetID)!
    let specialist = SessionSummary(id: repairSpecialistID, title: "Diagnostics", cwd: "/tmp",
                                    projectId: targetControl ? nil : "project", createdAt: 2, updatedAt: 2,
                                    state: "idle", mode: .ask, role: .diagnostics,
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
                                                   specialistHost: repairLocalHost, proposal: proposal)
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
    let request = try DiagnosticRepair.spawnRequest(handoff: handoff, destinationProjectId: "project",
                                                    admission: admission)
    #expect(request.mode == .build && request.role == nil)
    #expect(request.diagnosticRepair == admission)
    #expect(request.diagnosticTarget == nil && request.diagnosticHistoryAccess == nil)
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
    func buttons(_ view: NSView) -> [NSButton] {
        (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons)
    }
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while buttons(hosting).count < 2, ContinuousClock.now < deadline {
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(20))
    }
    let controls = buttons(hosting)
    try #require(controls.count == 2, "the production proposal tray has only Review and Not now actions")
    let review = try #require(controls.first { $0.title.contains("Review repair") })
    let dismiss = try #require(controls.first { $0.title == "Not now" })
    review.performClick(nil)
    dismiss.performClick(nil)
    #expect(reviews == 1 && dismissals == 1)
    #expect(client.fixtureSpawnRequests.isEmpty, "viewing, reviewing and dismissing the tray never starts a chat")
}
