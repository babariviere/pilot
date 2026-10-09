import Foundation
import PilotCore
import Testing

private let workspaceSessionJSON = #"{"id":"s","title":"Chat","cwd":"/workspace","createdAt":1,"updatedAt":2,"state":"parked""#

@Test func workspaceStorageDefaultsRemainCompatibleWithLegacySessions() throws {
    let oldInitializer = SessionSummary(id: "s", title: "Chat", cwd: "/workspace",
                                        createdAt: 1, updatedAt: 2, state: "parked")
    for suffix in ["}", #", "workspaceStorage":null,"workspaceReclaimedAt":null,"workspaceCleanupError":null}"#] {
        let session = try JSONDecoder().decode(SessionSummary.self, from: Data((workspaceSessionJSON + suffix).utf8))
        #expect(session == oldInitializer)
        #expect(session.workspaceStorage == nil)
        #expect(session.workspaceReclaimedAt == nil)
        #expect(session.workspaceCleanupError == nil)
        #expect(session.workspaceLabel == "Build workspace")
        let wire = try JSONValue.decode(JSONEncoder().encode(session))
        #expect(wire["workspaceStorage"] == nil)
        #expect(wire["workspaceReclaimedAt"] == nil)
        #expect(wire["workspaceCleanupError"] == nil)
    }
}

@Test func sharedWorkspaceFieldsRoundTripThroughSummaryAndSocketUpdates() throws {
    let json = workspaceSessionJSON + #", "workspace":"clone","workspaceStorage":"shared","archivedAt":3,"workspaceReclaimedAt":4,"workspaceCleanupError":"Unknown file blocks cleanup"}"#
    let session = try JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
    #expect(session.workspaceStorage == .shared)
    #expect(session.workspaceReclaimedAt == 4)
    #expect(session.workspaceCleanupError == "Unknown file blocks cleanup")
    #expect(session.workspaceLabel == "Archived workspace (restored on resume)")
    #expect(session.workspaceHelp.contains("repository history and bookmarks are shared with sibling sessions"))
    #expect(session.workspaceHelp.contains("Resume restores it from its pinned jj snapshot before work continues"))
    #expect(session.workspaceHelp.contains("Workspace cleanup failed: Unknown file blocks cleanup"))
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
    let event = try ServerUpdate.decode(Data((#"{"type":"session","session":"# + json + "}").utf8))
    guard case .session(let updated) = event else {
        Issue.record("Expected session update")
        return
    }
    #expect(updated == session)
}

@Test func workspaceLabelsPreferReclamationThenSharedStorageWithoutChangingLegacyLabels() {
    let shared = SessionSummary(id: "s", title: "Chat", cwd: "/workspace", createdAt: 1, updatedAt: 2,
                                state: "parked", archivedAt: 3, workspace: .clone, workspaceStorage: .shared)
    #expect(shared.workspaceLabel == "Shared jj workspace")
    #expect(shared.workspaceHelp.contains("working copy is isolated from your checkout"))
    #expect(!shared.workspaceHelp.contains("reclaimed"))
    let reclaimed = SessionSummary(id: "r", title: "Chat", cwd: "/workspace", createdAt: 1, updatedAt: 2,
                                   state: "parked", workspaceReclaimedAt: 0)
    #expect(reclaimed.workspaceLabel == "Archived workspace (restored on resume)")
    let clone = SessionSummary(id: "c", title: "Chat", cwd: "/workspace", createdAt: 1, updatedAt: 2,
                               state: "parked", archivedAt: 3, workspace: .clone)
    // Matches the composer's workspace choice, so one setting has one name.
    #expect(clone.workspaceLabel == "Isolated workspace")
    #expect(clone.workspaceHelp == "Build can make changes in this chat's workspace.")
    let direct = SessionSummary(id: "d", title: "Chat", cwd: "/workspace", createdAt: 1, updatedAt: 2,
                                state: "parked", workspace: .direct)
    #expect(direct.workspaceLabel == "Current checkout")
    let ask = SessionSummary(id: "a", title: "Chat", cwd: "/workspace", createdAt: 1, updatedAt: 2,
                             state: "parked", mode: .ask)
    #expect(ask.workspaceLabel == "Read-only · no isolated workspace")
    #expect(ask.workspaceHelp == "Ask can read and discuss this source, but cannot modify files, run a terminal, or publish. No isolated workspace is created.")
}

@Test func workspaceHelpKeepsAskPinnedCommitAndSurfacesCleanupWithoutChangingLabel() {
    let ask = SessionSummary(id: "a", title: "Chat", cwd: "/workspace", createdAt: 1, updatedAt: 2,
                             state: "parked", mode: .ask, sourceCommit: "abcdef012345")
    #expect(ask.workspaceHelp.hasSuffix("\nPinned source commit: abcdef012345"))
    let blocked = SessionSummary(id: "b", title: "Chat", cwd: "/workspace", createdAt: 1, updatedAt: 2,
                                 state: "parked", workspace: .clone, workspaceStorage: .shared,
                                 workspaceCleanupError: "Unknown file: scratch.txt")
    #expect(blocked.workspaceLabel == "Shared jj workspace")
    #expect(blocked.workspaceHelp.hasSuffix("\nWorkspace cleanup failed: Unknown file: scratch.txt"))
    #expect(!blocked.workspaceHelp.contains("was reclaimed"))
}
