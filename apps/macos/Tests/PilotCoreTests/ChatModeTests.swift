import Foundation
import PilotCore
import Testing

@Test func chatProtocolKeepsLegacyBuildDefaultsAndOmitsUnsetFields() throws {
    let legacy = Data(#"{"id":"old","title":"Old chat","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"parked"}"#.utf8)
    let session = try JSONDecoder().decode(SessionSummary.self, from: legacy)
    #expect(session.mode == nil)
    #expect(session.role == nil)
    #expect(session.effectiveMode == .build)
    #expect(!session.isAsk)
    #expect(session.workspaceLabel == "Build workspace")
    let request = try JSONDecoder().decode(SpawnRequest.self, from: Data(#"{"cwd":"/tmp","message":"hello"}"#.utf8))
    #expect(request.mode == nil)
    #expect(request.role == nil)
    #expect(request.workspace == nil)
    #expect(request.baseBranch == nil)
    let wire = try JSONValue.decode(JSONEncoder().encode(request))
    #expect(wire["mode"] == nil)
    #expect(wire["workspace"] == nil)
    #expect(wire["baseBranch"] == nil)
}

@Test func diagnosticsRoleAndBoundedHandoffProtocolRoundTrip() throws {
    let host = HostRef(hostId: "remote-box", daemonId: "daemon", lineageId: "lineage")
    let targetId = "01234567-89ab-4cde-8fab-0123456789ab"
    let target = try #require(DiagnosticTargetReference(host: host, sessionId: targetId))
    let request = SpawnRequest(projectId: "p", message: "Diagnose", mode: .ask, role: .diagnostics,
                               diagnosticTarget: target)
    let decoded = try JSONDecoder().decode(SpawnRequest.self, from: JSONEncoder().encode(request))
    #expect(decoded.role == .diagnostics)
    #expect(decoded.diagnosticTarget == target)
    let session = SessionSummary(id: "d", title: "Diagnose", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                                 state: "idle", mode: .ask, role: .diagnostics, diagnosticTargetId: targetId,
                                 diagnosticTarget: target)
    #expect(session.isDiagnosticsSpecialist)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
    let handoff = DiagnosticsHandoffRequest(targetSessionId: "target",
                                            evidenceRefs: ["diagnostic:v1:lifecycle:1"],
                                            likelyCause: "Likely cause",
                                            regressionTestGuidance: "Regression guidance")
    let handoffWire = try JSONValue.decode(JSONEncoder().encode(handoff))
    #expect(handoffWire["targetSessionId"]?.string == "target")
    #expect(handoffWire["evidenceRefs"]?.array?.count == 1)
    let wrongLink = Data(#"{"host":{"hostId":"remote-box","daemonId":"daemon","lineageId":"lineage"},"sessionId":"01234567-89ab-4cde-8fab-0123456789ab","chatUrl":"pilot://chat/00000000-0000-4000-8000-000000000001"}"#.utf8)
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(DiagnosticTargetReference.self, from: wrongLink) }
}

@Test func askAndBuildProtocolRoundTripsExactBranchAndWorkspace() throws {
    let request = SpawnRequest(projectId: "p", message: "Explain", baseBranch: "origin/literal", mode: .ask)
    let wire = try JSONValue.decode(JSONEncoder().encode(request))
    #expect(wire["mode"]?.string == "ask")
    #expect(wire["baseBranch"]?.string == "origin/literal")
    #expect(wire["workspace"] == nil)
    let build = SpawnRequest(projectId: "p", message: "Implement", mode: .build, workspace: .direct)
    let decoded = try JSONDecoder().decode(SpawnRequest.self, from: JSONEncoder().encode(build))
    #expect(decoded.mode == .build)
    #expect(decoded.workspace == .direct)
    let ask = SessionSummary(id: "a", title: "Ask", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "idle",
                             archivedAt: 3, mode: .ask, sourceBranch: "origin/literal", sourceCommit: "abcdef012345")
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(ask)) == ask)
    #expect(ask.isArchived && ask.isAsk)
    #expect(ask.sourceLabel == "origin/origin/literal")
    #expect(ask.workspaceLabel == "Read-only · no isolated workspace")
}

@Test func detachedBuildCloneHasAccurateWorkspaceBadge() throws {
    let clone = SessionSummary(id: "c", title: "Build", cwd: "/tmp/private", createdAt: 1, updatedAt: 2,
                               state: "idle", mode: .build, workspace: .clone)
    #expect(clone.branch == nil)
    #expect(clone.workspaceLabel == "Isolated workspace")
    #expect(clone.sourceLabel == "Default base")
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(clone)).workspace == .clone)
    let explicit = SessionSummary(id: "e", title: "Build", cwd: "/tmp/private", createdAt: 1, updatedAt: 2,
                                  state: "idle", mode: .build, sourceBranch: "feat/billing", workspace: .clone)
    #expect(explicit.branch == nil)
    #expect(explicit.workspaceLabel == "Isolated workspace")
    #expect(explicit.sourceLabel == "origin/feat/billing")
}

@Test func currentWorkspaceBaseRoundTripsAndShowsRefreshAge() throws {
    let session = SessionSummary(id: "lead", title: "Lead", cwd: "/workspace", createdAt: 0, updatedAt: 0,
                                 state: "idle", sourceBranch: "main", activeMissionCoordinator: true,
                                 workspaceBase: "1234567890abcdef", workspaceUpdatedAt: 60_000)
    #expect(session.workspaceBaseLabel(now: Date(timeIntervalSince1970: 181)) == "on main @ 12345678, updated 2 min ago")
    #expect(session.workspaceBaseLabel(now: Date(timeIntervalSince1970: 0)) == "on main @ 12345678, updated 0 min ago")
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
    let behind = SessionSummary(id: "lead", title: "Lead", cwd: "/workspace", createdAt: 0, updatedAt: 0,
                                state: "idle", sourceBranch: "main", activeMissionCoordinator: true,
                                workspaceBase: "1234567890abcdef", workspaceBehind: "Conflict")
    #expect(behind.workspaceBaseLabel() == "behind main @ 12345678, not yet updated")
}
