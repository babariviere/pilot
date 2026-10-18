import Foundation
import PilotCore
import Testing
@testable import Pilot

private let localHost = HostRef(hostId: "local", daemonId: "daemon", lineageId: "lineage")
private let project = Project(id: "project", name: "Project", path: "/projects/source", createdAt: 1)

private func sourceSession(control: Bool? = nil) -> SessionSummary {
    SessionSummary(id: control == true ? "00000000-0000-4000-8000-000000000001" : "01234567-89ab-4cde-8fab-0123456789ab",
                   title: "Sleeping target", cwd: "/projects/source",
                   projectId: control == true ? nil : project.id, createdAt: 1, updatedAt: 2,
                   state: "idle", mode: .ask)
}

@Test @MainActor func diagnoseStartsOnlyATargetScopedSpecialist() async throws {
    let app = AppModel()
    try app.registerLocal(localHost)
    let source = sourceSession()
    app.client.loadFixture(projects: [project], sessions: [source])
    app.selectedSessionId = source.id

    app.diagnose(source)
    let setup = try #require(app.diagnosticSetupTarget)
    #expect(app.client.fixtureSpawnRequests.isEmpty, "opening setup does not spawn")
    let resolved = try DiagnosticSetup.resolve(DiagnosticSetup.link(source.id), setup: setup,
                                               localHost: app.localHost, local: app.client.sessions, hosted: [])
    let prepared = try DiagnosticSetup.spawnRequest(target: resolved, model: "test/diagnostic",
                                                    thinking: "high", askingAboutPilot: false)
    let created = try await app.spawnDiagnostics(prepared, target: resolved.reference, tracksFeature: false)
    try app.selectSession(created)

    let request = try #require(app.client.fixtureSpawnRequests.first)
    #expect(request.role == .diagnostics)
    #expect(request.mode == .ask)
    #expect(request.diagnosticTarget?.sessionId == source.id)
    #expect(request.projectId == nil)
    #expect(request.cwd == nil)
    #expect(request.message.contains(source.title) == false)
    #expect(app.client.session(source.id) == source, "diagnosis does not mutate or replace the target")
    #expect(app.selectedSession?.isDiagnosticsSpecialist == true)
}

@Test @MainActor func askAboutPilotUsesTheControlChatAsAnExplicitTarget() async throws {
    let app = AppModel()
    try app.registerLocal(localHost)
    var control = sourceSession(control: true)
    control.control = true
    app.client.loadFixture(projects: [], sessions: [control])

    app.askAboutPilot()
    let setup = try #require(app.diagnosticSetupTarget)
    #expect(app.client.fixtureSpawnRequests.isEmpty, "opening setup does not spawn")
    let resolved = try DiagnosticSetup.resolve("", setup: setup, localHost: app.localHost,
                                               local: app.client.sessions, hosted: [])
    let prepared = try DiagnosticSetup.spawnRequest(target: resolved, model: "test/diagnostic",
                                                    thinking: "medium", askingAboutPilot: true,
                                                    question: "Why did Pilot stop responding after reconnect?")
    _ = try await app.spawnDiagnostics(prepared, target: resolved.reference, tracksFeature: false)

    let request = try #require(app.client.fixtureSpawnRequests.first)
    #expect(request.title == "Pilot diagnostics")
    #expect(request.role == .diagnostics)
    #expect(request.diagnosticTarget?.sessionId == control.id)
    #expect(request.model == "test/diagnostic")
    #expect(request.thinking == "medium")
    #expect(request.message == "Why did Pilot stop responding after reconnect?")
}

@Test @MainActor func repairRequiresASeparateExplicitHandoffAndOrdinaryBuildRequest() async throws {
    let evidenceRef = "diagnostic:v1:lifecycle:1"
    let handoff = try JSONDecoder().decode(DiagnosticsHandoff.self, from: Data("""
    {"schemaVersion":1,"host":{"hostId":"local","daemonId":"daemon","lineageId":"lineage"},
    "targetSessionId":"target","projectId":"project","evidence":[{"ref":"\(evidenceRef)",
    "source":"lifecycle","at":"2026-01-01T00:00:00.000Z","kind":"kernel.exit",
    "reason":"process_exit","state":"failed"}],"proposalId":"proposal","findings":"Worker exited.",
    "uncertainty":"medium","suggestedRepair":"Preserve the failure evidence.",
    "regressionTestGuidance":"Cover supervised exit."}
    """.utf8))
    let request = try DiagnosticRepair.spawnRequest(handoff: handoff, destinationProjectId: project.id)
    #expect(request.mode == .build)
    #expect(request.role == nil)
    #expect(request.diagnosticTarget == nil)
    #expect(request.projectId == project.id)
    #expect(request.cwd == nil)
    #expect(request.message.contains(evidenceRef))
    #expect(request.message.contains("do not retry, restart, replay") == true)
    let client = PilotClient()
    client.loadFixture(projects: [project], sessions: [])
    _ = try await client.spawn(request)
    #expect(client.fixtureSpawnRequests.count == 1, "one confirmed handoff creates one ordinary Build chat")
    #expect(client.fixtureSpawnRequests.first?.role == nil)
}

@Test @MainActor func controlTargetCanRequestProposalButCancelCreatesNoRepair() async throws {
    let app = AppModel()
    try app.registerLocal(localHost)
    var control = sourceSession(control: true)
    control.control = true
    let specialistId = "11111111-1111-4111-8111-111111111111"
    let target = try #require(DiagnosticTargetReference(host: localHost, sessionId: control.id))
    let specialist = SessionSummary(id: specialistId, title: "Pilot diagnostics", cwd: "/tmp",
                                    createdAt: 1, updatedAt: 2, state: "idle", mode: .ask,
                                    role: .diagnostics, diagnosticTargetId: control.id, diagnosticTarget: target)
    app.client.loadFixture(projects: [project], sessions: [control, specialist])
    #expect(app.canPrepareDiagnosticRepair(specialist, context: nil))
    app.prepareDiagnosticRepair(specialist, context: nil)
    let repair = try #require(app.diagnosticRepairTarget)
    #expect(repair.specialist.id == specialist.id)
    #expect(app.client.fixtureSpawnRequests.isEmpty)
    try await app.requestDiagnosticRepairProposal(repair)
    #expect(app.client.fixtureSendRequests.count == 1)
    #expect(app.client.fixtureSendRequests.first?.sessionId == specialist.id)
    #expect(app.client.fixtureSendRequests.first?.message.contains("repair_proposal") == true)
    #expect(app.client.fixtureSpawnRequests.isEmpty, "requesting a proposal cannot start a Build chat")
    app.diagnosticRepairTarget = nil
    #expect(app.client.fixtureSpawnRequests.isEmpty)
}

@Test func projectlessRepairRequiresAnExplicitBuildDestination() throws {
    let handoff = try JSONDecoder().decode(DiagnosticsHandoff.self, from: Data(#"{"schemaVersion":1,"host":{"hostId":"local","daemonId":"daemon","lineageId":"lineage"},"targetSessionId":"target","evidence":[],"proposalId":"proposal","findings":"Finding","uncertainty":"high","suggestedRepair":"Repair","regressionTestGuidance":"Test"}"#.utf8))
    let request = try DiagnosticRepair.spawnRequest(handoff: handoff, destinationProjectId: project.id)
    #expect(request.projectId == project.id)
    #expect(request.cwd == nil)
    #expect(throws: ClientError.self) {
        try DiagnosticRepair.spawnRequest(handoff: handoff, destinationProjectId: "")
    }
}

@Test func repairEligibilityExplainsDisconnectedMissingWrongHostAndStaleProposal() throws {
    let targetId = "01234567-89ab-4cde-8fab-0123456789ab"
    let targetSession = SessionSummary(id: targetId, title: "Target", cwd: "/tmp",
                                       createdAt: 1, updatedAt: 2, state: "idle")
    let reference = try #require(DiagnosticTargetReference(host: localHost, sessionId: targetId))
    let proposal = DiagnosticRepairProposal(
        id: "diagnostic-proposal:v1:11111111-1111-4111-8111-111111111111",
        targetSessionId: targetId, createdAt: "2026-01-01T00:00:00.000Z",
        evidenceRefs: ["diagnostic:v1:lifecycle:one"], findings: "Finding", uncertainty: .medium,
        suggestedRepair: "Repair", regressionTestGuidance: "Test")
    func specialist(_ target: DiagnosticTargetReference?,
                    proposal: DiagnosticRepairProposal? = nil) -> SessionSummary {
        SessionSummary(id: "11111111-1111-4111-8111-111111111111", title: "Diagnostics", cwd: "/tmp",
                       createdAt: 1, updatedAt: 2, state: "idle", mode: .ask, role: .diagnostics,
                       diagnosticTargetId: targetId, diagnosticTarget: target,
                       diagnosticRepairProposal: proposal)
    }
    #expect(DiagnosticRepair.problem(specialist: specialist(reference), specialistHost: localHost,
                                     admittedTarget: targetSession, available: false,
                                     destinationAvailable: true)?.contains("Reconnect") == true)
    #expect(DiagnosticRepair.problem(specialist: specialist(reference), specialistHost: localHost,
                                     admittedTarget: nil, available: true,
                                     destinationAvailable: true)?.contains("no longer available") == true)
    let wrongHost = try #require(DiagnosticTargetReference(
        host: HostRef(hostId: "local", daemonId: "other", lineageId: "lineage"), sessionId: targetId))
    #expect(DiagnosticRepair.problem(specialist: specialist(wrongHost), specialistHost: localHost,
                                     admittedTarget: targetSession, available: true,
                                     destinationAvailable: true)?.contains("different host") == true)
    let stale = DiagnosticRepairProposal(id: proposal.id, targetSessionId: "22222222-2222-4222-8222-222222222222",
                                         createdAt: proposal.createdAt, evidenceRefs: proposal.evidenceRefs,
                                         findings: proposal.findings, uncertainty: proposal.uncertainty,
                                         suggestedRepair: proposal.suggestedRepair,
                                         regressionTestGuidance: proposal.regressionTestGuidance)
    #expect(DiagnosticRepair.problem(specialist: specialist(reference, proposal: stale), specialistHost: localHost,
                                     admittedTarget: targetSession, available: true,
                                     destinationAvailable: true)?.contains("no longer matches") == true)
    #expect(DiagnosticRepair.problem(specialist: specialist(reference, proposal: proposal), specialistHost: localHost,
                                     admittedTarget: targetSession, available: true,
                                     destinationAvailable: false)?.contains("Choose a project") == true)
}

@Test @MainActor func newSessionPrefillIsConsumedOnceWithoutErasingOrdinaryDrafts() {
    let app = AppModel()
    let form = NewSessionForm()
    form.folder = "/wrong/folder"
    form.model = "previous/model"
    form.tab = .running
    form.error = "Old error"
    app.newSession(in: project.id, message: "Debug this session")
    form.consumeDraft(from: app)
    #expect(form.message == "Debug this session")
    #expect(form.folder.isEmpty)
    #expect(form.model.isEmpty)
    #expect(form.tab == .newTask)
    #expect(form.error == nil)
    #expect(app.draftMessage == nil)
}
