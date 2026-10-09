import Foundation
import PilotCore
import Testing

@Test func chatProtocolKeepsLegacyBuildDefaultsAndOmitsUnsetFields() throws {
    let legacy = Data(#"{"id":"old","title":"Old chat","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"parked"}"#.utf8)
    let session = try JSONDecoder().decode(SessionSummary.self, from: legacy)
    #expect(session.mode == nil)
    #expect(session.effectiveMode == .build)
    #expect(!session.isAsk)
    #expect(session.workspaceLabel == "Build workspace")
    let request = try JSONDecoder().decode(SpawnRequest.self, from: Data(#"{"cwd":"/tmp","message":"hello"}"#.utf8))
    #expect(request.mode == nil)
    #expect(request.workspace == nil)
    #expect(request.baseBranch == nil)
    let wire = try JSONValue.decode(JSONEncoder().encode(request))
    #expect(wire["mode"] == nil)
    #expect(wire["workspace"] == nil)
    #expect(wire["baseBranch"] == nil)
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
    #expect(clone.workspaceLabel == "Private clone")
    #expect(clone.sourceLabel == "Default base")
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(clone)).workspace == .clone)
    let explicit = SessionSummary(id: "e", title: "Build", cwd: "/tmp/private", createdAt: 1, updatedAt: 2,
                                  state: "idle", mode: .build, sourceBranch: "feat/billing", workspace: .clone)
    #expect(explicit.branch == nil)
    #expect(explicit.workspaceLabel == "Private clone")
    #expect(explicit.sourceLabel == "origin/feat/billing")
}
