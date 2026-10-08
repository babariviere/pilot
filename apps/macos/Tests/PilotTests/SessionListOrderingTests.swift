import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func clientFixtureListsUseSharedCompletionAndPROrdering() {
    let client = PilotClient()
    let closed = SessionSummary(id: "closed", title: "Closed", cwd: "/tmp", createdAt: 1, updatedAt: 10_000,
                                state: "working", pullRequest: SessionPullRequest(number: 1,
                                    url: "https://github.com/a/b/pull/1", title: "Closed", state: .closed, checkedAt: 1))
    let old = SessionSummary(id: "old", title: "Old", cwd: "/tmp", createdAt: 1, updatedAt: 9_000,
                             state: "idle", outcome: .done, outcomeAt: 100)
    let finished = SessionSummary(id: "finished", title: "Finished", cwd: "/tmp", createdAt: 1, updatedAt: 200,
                                  state: "idle", outcome: .done, outcomeAt: 200)
    client.loadFixture(projects: [], sessions: [closed, old, finished])
    #expect(client.activeSessions.map(\.id) == ["finished", "old", "closed"])
}
