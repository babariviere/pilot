import Foundation
import Testing
@testable import PilotCore

private func listSession(
    _ id: String, state: String = "idle", updatedAt: Double = 1_000,
    userAt: Double? = nil, outcome: SessionOutcome? = .done, finishAt: Double? = 500,
    prState: PullRequestState? = nil, prError: String? = nil
) -> SessionSummary {
    SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: updatedAt, state: state,
                   outcome: outcome, outcomeAt: finishAt,
                   pullRequest: prState.map { SessionPullRequest(number: 1, url: "https://github.com/a/b/pull/1",
                                                                title: "PR", state: $0, checkedAt: 1) },
                   pullRequestError: prError, lastUserMessageAt: userAt)
}

@Test func sessionOrderingPromotesCompletionsButKeepsTerminalPRsLast() throws {
    let sessions = [
        listSession("closed", state: "working", updatedAt: 99_000, prState: .closed),
        listSession("older", updatedAt: 90_000, userAt: 400, finishAt: 500),
        listSession("merged", updatedAt: 98_000, finishAt: 80_000, prState: .merged),
        listSession("working", state: "working", updatedAt: 2_000, finishAt: 99_000, prState: .open),
        listSession("just-finished", updatedAt: 3_000, userAt: 1_000, finishAt: 3_000, prState: .draft),
    ]
    let expected = ["just-finished", "working", "older", "closed", "merged"]
    #expect(sessions.sorted(by: SessionSummary.listPrecedes).map(\.id) == expected)
    let data = try JSONEncoder().encode(sessions)
    let update = try ServerUpdate.decode(Data("{\"type\":\"sessions\",\"sessions\":\(String(decoding: data, as: UTF8.self))}".utf8))
    guard case let .sessions(decoded) = update else { Issue.record("Expected sessions"); return }
    #expect(decoded.map(\.id) == expected)
}

@Test func completionTimeResetsAgeAndIgnoresPollingButRespectsLaterUserSubmissions() {
    for outcome in [SessionOutcome.done, .failed, .stopped] {
        let finished = listSession("s", updatedAt: 90_000, userAt: 10_000, outcome: outcome, finishAt: 60_000)
        #expect(finished.listActivityAt == 60_000)
        #expect(SessionTimeFormatting.relative(finished.listActivityAt, now: Date(timeIntervalSince1970: 60)) == "now")
        #expect(SessionTimeFormatting.relative(finished.listActivityAt, now: Date(timeIntervalSince1970: 120)) == "1m")
    }
    #expect(listSession("s", userAt: 800, finishAt: 500).listActivityAt == 800)
    #expect(listSession("s", updatedAt: 90_000).listActivityAt == 500)
    #expect(listSession("s", userAt: 700, outcome: nil, finishAt: nil).listActivityAt == 700)
    #expect(listSession("s", outcome: nil, finishAt: nil).listActivityAt == 1_000)
    for state in ["working", "starting"] {
        #expect(listSession("s", state: state, userAt: 2_000, finishAt: 3_000).listActivityAt == 1_000)
    }
    #expect(listSession("s", userAt: .nan, finishAt: .infinity).listActivityAt == 1_000)
}

@Test func sessionListTiesAreDeterministicAndUnaffectedByMetadataUpdates() {
    let first = listSession("a", updatedAt: 1_000)
    let second = listSession("b", updatedAt: 9_000)
    #expect([second, first].sorted(by: SessionSummary.listPrecedes).map(\.id) == ["a", "b"])
    #expect(!SessionSummary.listPrecedes(first, first))
}

@Test func stableUserTimestampIsOptionalAndRoundTrips() throws {
    let old = #"{"id":"s","title":"Task","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle"}"#
    #expect(try JSONDecoder().decode(SessionSummary.self, from: Data(old.utf8)).lastUserMessageAt == nil)
    let session = listSession("s", userAt: 100)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
}

@Test func terminalPullRequestsSuppressAttentionAndObserveVersionsWithoutReplay() {
    for prState in [PullRequestState.closed, .merged] {
        for outcome in [SessionOutcome.done, .failed, .stopped] {
            let suite = "TerminalPRAttentionTests.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            let attention = SessionAttention(defaults: defaults)
            _ = attention.observe([], snapshot: true)
            let terminal = listSession("s", outcome: outcome, prState: prState, prError: "Offline")
            #expect(terminal.hasTerminalPullRequest)
            #expect(!attention.isUnread(terminal))
            #expect(attention.observe([terminal], snapshot: false).isEmpty)
            let reopened = listSession("s", outcome: outcome, prState: .open)
            #expect(attention.observe([reopened], snapshot: false).isEmpty)
            #expect(attention.isUnread(reopened))
            let reloaded = SessionAttention(defaults: defaults)
            #expect(reloaded.observe([reopened], snapshot: true).isEmpty)
            #expect(reloaded.observe([reopened], snapshot: false).isEmpty)
            let fresh = listSession("s", outcome: outcome, finishAt: 600, prState: .draft)
            #expect(reloaded.observe([fresh], snapshot: false).count == 1)
        }
    }
}

@Test func terminalPullRequestsAlsoSuppressWorkingRetainedCompletionVersions() {
    let suite = "TerminalPRWorkingTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let attention = SessionAttention(defaults: defaults)
    _ = attention.observe([], snapshot: true)
    #expect(attention.observe([listSession("s", state: "working", prState: .merged)], snapshot: false).isEmpty)
    #expect(attention.observe([listSession("s", prState: .open)], snapshot: false).isEmpty)
}
