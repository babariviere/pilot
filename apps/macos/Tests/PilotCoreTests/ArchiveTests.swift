import Foundation
import Testing
@testable import PilotCore

private func archiveSession(state: String = "idle", archivedAt: Double? = nil, projectId: String? = nil) -> SessionSummary {
    SessionSummary(id: UUID().uuidString, title: "Chat", cwd: "/tmp", projectId: projectId,
                   createdAt: 1, updatedAt: 2, state: state, archivedAt: archivedAt)
}

@Test func archiveDecodingIsBackwardsCompatible() throws {
    let json = #"{"id":"s","title":"Chat","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle""#
    for suffix in ["}", #", "archivedAt":null}"#] {
        let session = try JSONDecoder().decode(SessionSummary.self, from: Data((json + suffix).utf8))
        #expect(session.archivedAt == nil)
        #expect(!session.isArchived)
        #expect(session.canArchive)
    }
    let session = try JSONDecoder().decode(SessionSummary.self, from: Data((json + #", "archivedAt":1710000000123}"#).utf8))
    #expect(session.archivedAt == 1_710_000_000_123)
    #expect(session.isArchived)
    #expect(!session.canArchive)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
}

@Test func archiveFilteringPreservesAllSessionsAndProjectMembership() {
    let active = archiveSession(projectId: "p1")
    let archived = archiveSession(archivedAt: 0, projectId: "p1")
    let other = archiveSession(archivedAt: 3, projectId: "p2")
    let unassigned = archiveSession(archivedAt: 4)
    let all = [active, archived, other, unassigned]
    #expect(all.unarchivedSessions == [active])
    #expect(all.archivedSessions == [archived, other, unassigned])
    #expect(all.archivedSessions.filter { $0.projectId == "p1" } == [archived])
    #expect(all.first { $0.id == archived.id } == archived)
    #expect(all.count == 4)
}

@Test func runningSessionsRequireStopBeforeArchive() {
    for state in ["working", "starting"] {
        #expect(!archiveSession(state: state).canArchive)
    }
    for state in ["idle", "failed", "parked"] {
        #expect(archiveSession(state: state).canArchive)
    }
    #expect(!archiveSession(archivedAt: 0).canArchive)
}

@Test func archivedSessionKeepsOutcomeAndPullRequestInTypedUpdates() throws {
    let session = SessionSummary(
        id: "archived", title: "Chat", cwd: "/tmp", projectId: "p", branch: "pilot/chat",
        createdAt: 1, updatedAt: 10, state: "stopped", error: "Previous error",
        usage: SessionUsage(context: ContextUsage(tokens: 100, contextWindow: 1000)),
        outcome: .done, outcomeAt: 5, outcomeReason: "Review the PR",
        pullRequest: SessionPullRequest(number: 11, url: "https://github.com/example/repo/pull/11",
                                       title: "Archive chats", state: .open, checkedAt: 6),
        pullRequestError: "Cached lookup", archivedAt: 10
    )
    let encoded = try JSONEncoder().encode(session)
    let json = String(decoding: encoded, as: UTF8.self)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: encoded) == session)
    let delta = try ServerUpdate.decode(Data("{\"type\":\"session\",\"session\":\(json)}".utf8))
    guard case let .session(decoded) = delta else {
        Issue.record("Expected a typed session update")
        return
    }
    #expect(decoded == session)
    #expect(decoded.status == .done)
    #expect(decoded.pullRequestIsStale)
    #expect(!decoded.canArchive)
    let snapshot = try ServerUpdate.decode(Data("{\"type\":\"sessions\",\"sessions\":[\(json)]}".utf8))
    guard case let .sessions(list) = snapshot else {
        Issue.record("Expected a typed session snapshot")
        return
    }
    #expect(list == [session])
    #expect(list.unarchivedSessions.isEmpty)
    #expect(list.archivedSessions == [session])
}
