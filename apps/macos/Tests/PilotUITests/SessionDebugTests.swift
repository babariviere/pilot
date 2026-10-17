import Foundation
import PilotCore
import Testing
@testable import Pilot

private let localHost = HostRef(hostId: "local", daemonId: "daemon", lineageId: "lineage")
private let project = Project(id: "project", name: "Project", path: "/projects/source", createdAt: 1)

private func sourceSession(control: Bool? = nil) -> SessionSummary {
    SessionSummary(id: control == true ? "control" : "source", title: "Sleeping target", cwd: "/projects/source",
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
    for _ in 0..<100 where app.client.fixtureSpawnRequests.isEmpty { await Task.yield() }

    let request = try #require(app.client.fixtureSpawnRequests.first)
    #expect(request.role == .diagnostics)
    #expect(request.mode == .ask)
    #expect(request.diagnosticTargetId == source.id)
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
    for _ in 0..<100 where app.client.fixtureSpawnRequests.isEmpty { await Task.yield() }

    let request = try #require(app.client.fixtureSpawnRequests.first)
    #expect(request.title == "Ask about Pilot")
    #expect(request.role == .diagnostics)
    #expect(request.diagnosticTargetId == control.id)
}

@Test @MainActor func repairRequiresASeparateExplicitHandoffAndOrdinaryBuildRequest() throws {
    let evidenceRef = "diagnostic:v1:lifecycle:1"
    let handoff = try JSONDecoder().decode(DiagnosticsHandoff.self, from: Data("""
    {"schemaVersion":1,"host":{"hostId":"local","daemonId":"daemon","lineageId":"lineage"},
    "targetSessionId":"target","projectId":"project","evidence":[{"ref":"\(evidenceRef)",
    "source":"lifecycle","at":"2026-01-01T00:00:00.000Z","kind":"kernel.exit",
    "reason":"process_exit","state":"failed"}],"likelyCause":"Worker exited.",
    "regressionTestGuidance":"Cover supervised exit."}
    """.utf8))
    let request = try DiagnosticRepair.spawnRequest(handoff: handoff, fallbackCwd: "/not-used")
    #expect(request.mode == .build)
    #expect(request.role == nil)
    #expect(request.diagnosticTargetId == nil)
    #expect(request.projectId == project.id)
    #expect(request.cwd == nil)
    #expect(request.message.contains(evidenceRef))
    #expect(request.message.contains("do not retry, restart, replay") == true)
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
