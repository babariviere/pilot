import Foundation
import PilotCore
import Testing
@testable import Pilot

private let bindingHost = HostRef(hostId: "local", daemonId: "daemon", lineageId: "lineage")
private let bindingProject = Project(id: "source", name: "Not selected by name", path: "/sources/pilot", createdAt: 1)

@Test @MainActor func repairProjectSetupIsExplicitAndCannotSelectAnUnverifiedProject() async throws {
    let client = PilotClient()
    client.loadFixture(projects: [bindingProject], sessions: [])
    let app = AppModel(client: client)
    try app.registerLocal(bindingHost)
    try app.hosts.install(client, host: bindingHost)
    #expect(try await app.diagnosticRepairProject(on: bindingHost).state == .missing)
    #expect(client.fixtureRepairProject == nil, "reading settings never configures a destination")
    let request = DiagnosticRepairProjectSetup(expectedRevision: 0, host: bindingHost, projectId: bindingProject.id,
        path: bindingProject.path, origin: DiagnosticRepairProjectBinding.requiredOrigin)
    await #expect(throws: ClientError.self) { _ = try await app.configureDiagnosticRepairProject(request) }
    #expect(client.fixtureRepairProject == nil)
    client.fixtureProjectOrigins[bindingProject.id] = ProjectOrigin(identity: DiagnosticRepairProjectBinding.requiredOrigin)
    let saved = try await app.configureDiagnosticRepairProject(request)
    #expect(saved.binding?.matches(host: bindingHost, projects: [bindingProject]) == true)
    #expect(saved.revision == 1)
    #expect(client.fixtureSpawnRequests.isEmpty, "setup grants no repair start")
    await #expect(throws: ClientError.self) { _ = try await app.configureDiagnosticRepairProject(request) }
}

@Test @MainActor func standaloneAppCanRequestAProposalWithoutAControlOrFocusChat() async throws {
    let client = PilotClient()
    var specialist = SessionSummary(id: "11111111-1111-4111-8111-111111111111", title: "Sidebar investigation", cwd: "/tmp",
        createdAt: 1, updatedAt: 1, state: "idle", mode: .ask, role: .diagnostics, diagnosticScope: .app)
    specialist.diagnosticHost = bindingHost
    client.loadFixture(projects: [], sessions: [specialist])
    let app = AppModel(client: client)
    try app.registerLocal(bindingHost)
    let reference = HostResourceRef(host: bindingHost, kind: .session, localId: specialist.id)
    try await app.requestDiagnosticRepairProposal(DiagnosticRepairTarget(specialist: specialist, reference: reference))
    #expect(app.diagnosticRepairRequest(for: reference)?.target == .app(host: bindingHost))
    #expect(client.fixtureSendRequests.count == 1)
    #expect(client.fixtureSendRequests.first?.message.contains("repairTitle") == true)
    #expect(client.fixtureSpawnRequests.isEmpty)
    #expect(DiagnosticRepair.targetProblem(specialist: specialist, specialistHost: bindingHost,
        admittedTarget: nil, available: true) == nil)
}

@Test func standaloneAppRepairKeepsItsSubjectAndCannotBorrowAnotherDestination() throws {
    let subject = DiagnosticEvidenceSubject.app(host: bindingHost)
    let proposal = DiagnosticRepairProposal(id: "diagnostic-proposal:v1:00000000-0000-4000-8000-000000000001",
        createdAt: "2026-10-19T00:00:00Z", evidenceRefs: ["diagnostic:v1:host:one"],
        findings: "Sidebar keeps obsolete selection", uncertainty: .high, suggestedRepair: "Fence the selection",
        regressionTestGuidance: "Switch hosts in the mounted sidebar", subject: subject,
        repairTitle: "Sidebar keeps obsolete selection")
    let specialist = SessionSummary(id: "11111111-1111-4111-8111-111111111111", title: "Investigation", cwd: "/tmp",
        createdAt: 1, updatedAt: 1, state: "idle", mode: .ask, role: .diagnostics, diagnosticScope: .app,
        diagnosticRepairProposal: proposal)
    let binding = DiagnosticRepairProjectBinding(id: "00000000-0000-4000-8000-000000000009", revision: 3,
        host: bindingHost, projectId: bindingProject.id, path: bindingProject.path, configuredAt: "2026-10-19T00:00:00Z")
    let admission = try DiagnosticRepair.admission(specialist: specialist, specialistHost: bindingHost,
        proposal: proposal, binding: binding)
    let json = #"{"schemaVersion":1,"host":{"hostId":"local","daemonId":"daemon","lineageId":"lineage"},"subject":{"kind":"app","host":{"hostId":"local","daemonId":"daemon","lineageId":"lineage"}},"evidence":[],"proposalId":"diagnostic-proposal:v1:00000000-0000-4000-8000-000000000001","findings":"Sidebar keeps obsolete selection","uncertainty":"high","suggestedRepair":"Fence the selection","regressionTestGuidance":"Test","repairTitle":"Sidebar keeps obsolete selection","projectId":"untrusted-destination"}"#
    let handoff = try JSONDecoder().decode(DiagnosticsHandoff.self, from: Data(json.utf8))
    let request = try DiagnosticRepair.spawnRequest(handoff: handoff, destinationProjectId: bindingProject.id,
        admission: admission, model: "test/model")
    #expect(request.projectId == bindingProject.id)
    #expect(request.role == nil && request.mode == .build && request.workspace == .clone)
    #expect(request.title == proposal.repairTitle)
    #expect(request.diagnosticRepair?.evidenceSubject == subject && request.diagnosticRepair?.target == nil)
    #expect(throws: ClientError.self) {
        try DiagnosticRepair.spawnRequest(handoff: handoff, destinationProjectId: "untrusted-destination", admission: admission)
    }
}

@Test func compatibilityRepairTitlesAreIssueSpecificPlainBoundedAndNonempty() {
    func proposal(_ findings: String) -> DiagnosticRepairProposal {
        DiagnosticRepairProposal(id: "proposal", createdAt: "2026-10-19T00:00:00Z", evidenceRefs: [], findings: findings,
            uncertainty: .high, suggestedRepair: "Repair", regressionTestGuidance: "Test")
    }
    #expect(DiagnosticRepair.title(proposal("Sidebar selection persists")) != DiagnosticRepair.title(proposal("Reconnect stalls")))
    #expect(!DiagnosticRepair.title(proposal("")).isEmpty)
    #expect(DiagnosticRepair.title(proposal(String(repeating: "😀", count: 200))).utf16.count <= 160)
    #expect(!DiagnosticRepair.title(proposal("token=private")).contains("private"))
    #expect(!DiagnosticRepair.title(proposal("a\u{202E}b")).contains("\u{202E}"))
}
