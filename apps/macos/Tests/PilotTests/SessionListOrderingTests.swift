import Combine
import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func sessionDeltasPublishOnceAndOnlyWhenChanged() {
    let client = PilotClient()
    let first = SessionSummary(id: "first", title: "First", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "working")
    let second = SessionSummary(id: "second", title: "Second", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "working")
    client.loadFixture(projects: [], sessions: [first, second])
    var changes = 0
    let observation = client.objectWillChange.sink { changes += 1 }
    defer { observation.cancel() }

    // Every observer of the session list (window, chat header) re-evaluates on each publication.
    client.handle(.session(second))
    #expect(changes == 0)
    let updated = SessionSummary(id: "second", title: "Second", cwd: "/tmp", createdAt: 1, updatedAt: 3, state: "working")
    client.handle(.session(updated))
    #expect(changes == 1)
    #expect(client.activeSessions.map(\.id) == ["second", "first"])
}

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

@Test @MainActor func clientPinSnapshotsAndDeltasReorderWithoutLosingSessions() throws {
    let client = PilotClient()
    let old = SessionSummary(id: "old", title: "Old", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "working")
    let recent = SessionSummary(id: "recent", title: "Recent", cwd: "/tmp", createdAt: 1, updatedAt: 100, state: "working")
    let pinned = SessionSummary(id: "old", title: "Old", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                                state: "working", pinned: true)
    client.loadFixture(projects: [], sessions: [recent, pinned])
    #expect(client.activeSessions == [pinned, recent])
    let json = String(decoding: try JSONEncoder().encode([recent, pinned]), as: UTF8.self)
    let snapshot = try #require(try ServerUpdate.decode(Data("{\"type\":\"sessions\",\"sessions\":\(json)}".utf8)))
    client.handle(snapshot)
    #expect(client.activeSessions == [pinned, recent])
    client.handle(.session(old))
    #expect(client.activeSessions == [recent, old])
    client.handle(.session(pinned))
    #expect(client.activeSessions == [pinned, recent])
    #expect(client.workingCount == 2)
}
