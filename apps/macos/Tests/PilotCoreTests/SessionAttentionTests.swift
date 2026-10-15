import Foundation
import Testing
@testable import PilotCore

private func summary(
    id: String = "s", state: String = "idle", outcome: SessionOutcome? = .done,
    at: Double? = 100, updatedAt: Double = 200, reason: String? = nil
) -> SessionSummary {
    SessionSummary(id: id, title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: updatedAt,
                   state: state, outcome: outcome, outcomeAt: at, outcomeReason: reason)
}

private func withDefaults(_ test: (UserDefaults) throws -> Void) rethrows {
    let suite = "SessionAttentionTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    try test(defaults)
}

@Test func outcomeProtocolIsOptionalAndRoundTrips() throws {
    let old = try JSONDecoder().decode(SessionSummary.self, from: Data(#"{"id":"s","title":"Task","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle"}"#.utf8))
    #expect(old.outcome == nil)
    #expect(old.outcomeAt == nil)
    #expect(old.status == .idle)
    for outcome in [SessionOutcome.done, .failed, .stopped, .question] {
        let session = summary(outcome: outcome, at: 1234, reason: "Turn completed")
        let encoded = try JSONEncoder().encode(session)
        #expect(String(decoding: encoded, as: UTF8.self).contains("\"outcome\":\"\(outcome.rawValue)\""))
        #expect(try JSONDecoder().decode(SessionSummary.self, from: encoded) == session)
    }
}

@Test func offlinePauseIsQuietAndComposesWithSleep() throws {
    var chat = summary(state: "working", outcome: .failed, reason: "Old result")
    chat.offlinePaused = true
    #expect(chat.status == .offlinePaused)
    #expect(!chat.isWorking)
    #expect(chat.visibleOutcomeAt == nil)
    #expect(RowLineSegments.session(chat).contains { $0 == RowLineSegment(.reason("Paused offline")) })
    let encoded = try JSONEncoder().encode(chat)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: encoded).offlinePaused == true)
    chat.sleepPaused = true
    #expect(chat.status == .paused)
    chat.offlinePaused = false
    #expect(chat.status == .paused)
}

@Test func legacyNeedsInputDecodesAsDoneAndEncodesNormally() throws {
    let outcome = try JSONDecoder().decode(SessionOutcome.self, from: Data(#""needs_input""#.utf8))
    #expect(outcome == .done)
    #expect(String(decoding: try JSONEncoder().encode(outcome), as: UTF8.self) == #""done""#)
    let json = #"{"id":"s","title":"Task","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"stopped","outcome":"needs_input","outcomeAt":100,"outcomeReason":"Choose a provider"}"#
    let session = try JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
    #expect(session.status == .done)
    #expect(session.visibleOutcomeAt == 100)
    #expect(session.outcomeReason == "Choose a provider")
    for update in ["{\"type\":\"session\",\"session\":\(json)}", "{\"type\":\"sessions\",\"sessions\":[\(json)]}"] {
        switch try ServerUpdate.decode(Data(update.utf8)) {
        case let .session(decoded): #expect(decoded == session)
        case let .sessions(decoded): #expect(decoded == [session])
        default: Issue.record("Expected a typed session update")
        }
    }
    let encoded = try JSONEncoder().encode(session)
    #expect(!String(decoding: encoded, as: UTF8.self).contains("needs_input"))
    #expect(try JSONDecoder().decode(SessionSummary.self, from: encoded) == session)
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        _ = attention.observe([], snapshot: true)
        #expect(attention.isUnread(session))
        let notification = attention.observe([session], snapshot: false).first
        #expect(notification?.title == "Session done")
        #expect(notification?.body == "Task\nChoose a provider")
        #expect(attention.review(session, chatVisible: true, appActive: true))
        #expect(!attention.isUnread(session))
    }
}

@Test func unknownOutcomeStillFailsDecoding() {
    for json in [#""unknown""#, "null", "123"] {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SessionOutcome.self, from: Data(json.utf8))
        }
    }
}

@Test func backgroundWorkUsesDaemonStateForAttentionCountsAndNotifications() throws {
    let job = SessionJob(id: "tests", name: "Tests", startedAt: 1, outputPath: "/tmp/tests.log")
    func chat(working: Bool?, jobs: [SessionJob]?, outcome: SessionOutcome? = .done, at: Double? = 42) -> SessionSummary {
        SessionSummary(id: "jobs", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "idle",
                       outcome: outcome, outcomeAt: at, runningJobs: jobs, working: working)
    }
    let running = chat(working: true, jobs: [job])
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(running)) == running)
    #expect(chat(working: nil, jobs: [job]).isWorking) // Old daemon compatibility.
    #expect(!chat(working: nil, jobs: []).isWorking)
    #expect(!chat(working: false, jobs: [job]).isWorking) // Daemon value is authoritative.
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        _ = attention.observe([], snapshot: true)
        for session in [running, chat(working: true, jobs: []), chat(working: true, jobs: nil, outcome: nil, at: nil)] {
            #expect(session.isWorking)
            #expect(session.status == .working)
            #expect(session.visibleOutcomeAt == nil)
            #expect(!attention.isUnread(session))
            #expect(!attention.isHeld(session))
            #expect(attention.observe([session], snapshot: false).isEmpty)
            #expect(session.signal(unread: true) == .working)
            let groups = SidebarUrgency.groups([session], unread: attention.isUnread, held: attention.isHeld)
            #expect(groups.working.count == 1)
            #expect(groups.needsYou.isEmpty)
            #expect([session].filter(\.isWorking).count == 1)
        }
        let finished = chat(working: false, jobs: nil, at: 43)
        #expect(attention.isUnread(finished))
        #expect(attention.observe([finished], snapshot: false).count == 1)
        #expect(attention.observe([finished], snapshot: true).isEmpty)
    }
}

@Test func statusIsIndependentOfLifecycleAndHiddenWhileWorking() {
    for state in ["idle", "stopped", "failed"] {
        #expect(summary(state: state).status == .done)
    }
    for state in ["working", "starting"] {
        #expect(summary(state: state, outcome: .failed).status == .working)
        #expect(summary(state: state).visibleOutcomeAt == nil)
    }
    #expect(summary(outcome: .failed).status.rawValue == "Failed")
    #expect(summary(outcome: .stopped).status.rawValue == "Stopped")
    #expect(summary(outcome: .done).status.rawValue == "Done")
    #expect(summary(outcome: nil).status == .idle)
}

@Test func reviewRequiresVisibleChatInActiveAppAndPersists() {
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        let session = summary(outcome: .done)
        #expect(attention.isUnread(session))
        #expect(!attention.review(session, chatVisible: true, appActive: false))
        #expect(!attention.review(session, chatVisible: false, appActive: true))
        #expect(attention.isUnread(session))
        #expect(attention.review(session, chatVisible: true, appActive: true))
        #expect(!attention.isUnread(session))
        #expect(session.status == .done)
        let reopened = SessionAttention(defaults: defaults)
        #expect(!reopened.isUnread(summary(state: "stopped", outcome: .done, updatedAt: 999)))
        #expect(reopened.isUnread(summary(outcome: .done, at: 101)))
        #expect(reopened.review(summary(at: 101), chatVisible: true, appActive: true))
        #expect(!SessionAttention(defaults: defaults).isUnread(summary(at: 101)))
    }
}

@Test func oldRetainedOutcomeIsHiddenWhileWorkingAndReturnsAfterParking() {
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        let working = summary(state: "working", outcome: .done)
        #expect(!attention.isUnread(working))
        #expect(!attention.review(working, chatVisible: true, appActive: true))
        #expect(attention.isUnread(summary(state: "stopped", outcome: .done)))
        #expect(!attention.isUnread(summary(outcome: nil)))
        #expect(!attention.isUnread(summary(at: nil)))
    }
}

@Test func initialSnapshotIsQuietButReconnectCatchesNewOutcomeWithoutTransitions() {
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        #expect(attention.observe([summary()], snapshot: true).isEmpty)
        #expect(attention.isUnread(summary()))
        #expect(attention.observe([summary(updatedAt: 999)], snapshot: true).isEmpty)
        let notifications = attention.observe([summary(state: "stopped", outcome: .done, at: 101)], snapshot: true)
        #expect(notifications.count == 1)
        #expect(notifications.first?.title == "Session done")
        #expect(attention.observe([summary(state: "stopped", outcome: .done, at: 101, updatedAt: 1234)], snapshot: false).isEmpty)
        #expect(attention.observe([summary(at: 101)], snapshot: true).isEmpty)
        let reopened = SessionAttention(defaults: defaults)
        #expect(reopened.observe([summary(at: 101)], snapshot: true).isEmpty)
        #expect(reopened.observe([summary(at: 101)], snapshot: false).isEmpty)
    }
}

@Test func notificationTitlesReasonsAndDeduplicationUseOutcomeVersion() {
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        _ = attention.observe([], snapshot: true)
        let cases: [(SessionOutcome, String)] = [
            (.done, "Session done"),
            (.failed, "Session failed"), (.stopped, "Session stopped"),
        ]
        for (index, item) in cases.enumerated() {
            let session = summary(outcome: item.0, at: Double(index + 1), reason: "Reason")
            let notification = attention.observe([session], snapshot: false).first
            #expect(notification?.title == item.1)
            #expect(notification?.body == "Task\nReason")
            #expect(notification?.identifier == "s-outcome-\(Double(index + 1))")
            #expect(attention.observe([session], snapshot: false).isEmpty)
            #expect(attention.observe([summary(state: "stopped", outcome: item.0, at: Double(index + 1), updatedAt: 999)], snapshot: true).isEmpty)
        }
        #expect(attention.observe([summary(at: 1)], snapshot: false).isEmpty)
    }
}

@Test func notificationsWaitUntilNotWorkingAndSkipReviewedResults() {
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        _ = attention.observe([summary(state: "working")], snapshot: true)
        #expect(attention.observe([summary()], snapshot: false).isEmpty)
        #expect(attention.observe([summary(state: "working", at: 101)], snapshot: false).isEmpty)
        #expect(attention.observe([summary(at: 101)], snapshot: false).count == 1)
        _ = attention.review(summary(at: 102), chatVisible: true, appActive: true)
        #expect(attention.observe([summary(at: 102)], snapshot: false).isEmpty)
        #expect(attention.observe([summary(outcome: nil)], snapshot: false).isEmpty)
        #expect(attention.observe([summary(at: nil)], snapshot: false).isEmpty)
    }
}

@Test func agentQuestionsNeedTheUserAndNotifyWithTheQuestion() {
    let asking = summary(outcome: .question, at: 300, reason: "Where should retries live?")
    #expect(asking.status == .question)
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        _ = attention.observe([], snapshot: true)
        let notification = attention.observe([asking], snapshot: false).first
        #expect(notification?.title == "Question")
        #expect(notification?.body == "Task\nWhere should retries live?")
        // Settled PRs do not hide a question.
        let merged = SessionSummary(id: "m", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "idle",
                                    outcome: .question, outcomeAt: 300,
                                    pullRequest: SessionPullRequest(number: 1, url: "https://github.com/o/r/pull/1",
                                                                    title: "PR", state: .merged, checkedAt: 1))
        #expect(merged.hasTerminalPullRequest)
        #expect(attention.isUnread(merged))
    }
}

@Test func readResultKeepsItsGroupUntilTheUserLeavesTheChat() {
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        let done = summary(at: 100)
        let other = summary(id: "o", at: 50)
        _ = attention.observe([done], snapshot: true)
        let group = { (session: SessionSummary) in
            SidebarUrgency.groups([session], unread: attention.isUnread, held: attention.isHeld)
        }
        #expect(group(done).needsYou == [done])
        #expect(attention.review(done, chatVisible: true, appActive: true))
        #expect(!attention.isUnread(done))
        // While the chat stays open, its row does not move.
        #expect(attention.isHeld(done))
        #expect(group(done).needsYou == [done])
        #expect(!attention.leave(keeping: "s"))
        #expect(attention.isHeld(done))

        // Reconnects keep the open chat in place without making it unread or notifying again.
        #expect(attention.observe([done], snapshot: true).isEmpty)
        #expect(attention.observe([done], snapshot: false).isEmpty)
        #expect(attention.isHeld(done))
        #expect(!attention.isUnread(done))

        // Opening another chat leaves this one: it regroups to Recent, and only the open chat is held.
        #expect(attention.review(other, chatVisible: true, appActive: true))
        #expect(attention.leave(keeping: "o"))
        #expect(!attention.isHeld(done))
        #expect(attention.isHeld(other))
        #expect(group(done).recent == [done])
        #expect(group(done).needsYou.isEmpty)

        // Leaving every chat (Home, the Inbox or closing the window) releases the rest.
        #expect(attention.leave(keeping: nil))
        #expect(!attention.isHeld(other))
        #expect(!attention.leave(keeping: nil))

        // Nothing persists: a relaunch neither holds nor re-reads.
        #expect(attention.review(summary(id: "n", at: 10), chatVisible: true, appActive: true))
        let relaunched = SessionAttention(defaults: defaults)
        #expect(!relaunched.isHeld(summary(id: "n", at: 10)))
        #expect(!relaunched.isUnread(summary(id: "n", at: 10)))

        // A reply, a newer result or archiving end the hold while the chat is still open.
        #expect(!attention.isHeld(summary(id: "n", state: "working", at: 10)))
        #expect(!attention.isHeld(summary(id: "n", at: 20)))
        let archived = SessionSummary(id: "n", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 200, state: "idle",
                                      outcome: .done, outcomeAt: 10, archivedAt: 70)
        #expect(!attention.isHeld(archived))
    }
}

@Test func readyPullRequestSupersedesUnreadAndHeldResultsWithoutMarkingThemReviewed() {
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        let pr = SessionPullRequest(number: 1, url: "https://github.com/o/r/pull/1", title: "PR", state: .open,
                                    checkedAt: 1, readiness: .init(state: .ready, reasons: [], checkedAt: 1))
        let ready = SessionSummary(id: "r", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 200, state: "idle",
                                   outcome: .done, outcomeAt: 100, pullRequest: pr, pullRequests: [pr])
        let group = { SidebarUrgency.groups([ready], unread: attention.isUnread, held: attention.isHeld) }
        #expect(attention.isUnread(ready))
        #expect(group().needsYou.isEmpty)
        #expect(group().readyToMerge == [ready])
        #expect(attention.review(ready, chatVisible: true, appActive: true))
        #expect(group().needsYou.isEmpty)
        #expect(group().readyToMerge == [ready])
        #expect(attention.leave(keeping: nil))
        #expect(group().readyToMerge == [ready])
        #expect(group().needsYou.isEmpty)
    }
}

@Test func failuresAndQuestionsStayUnderNeedsYouAfterLeaving() {
    withDefaults { defaults in
        let attention = SessionAttention(defaults: defaults)
        let failed = summary(id: "f", outcome: .failed)
        let question = summary(id: "q", outcome: .question)
        for session in [failed, question] {
            #expect(attention.review(session, chatVisible: true, appActive: true))
        }
        #expect(attention.leave(keeping: nil))
        let groups = SidebarUrgency.groups([failed, question], unread: attention.isUnread, held: attention.isHeld)
        #expect(groups.needsYou == [failed, question])
    }
}

@Test func legacyAwaitingReplyEntriesAreDropped() {
    withDefaults { defaults in
        defaults.set(["s": 100.0], forKey: "pilot.awaitingReplyOutcomeAt")
        let attention = SessionAttention(defaults: defaults)
        #expect(defaults.object(forKey: "pilot.awaitingReplyOutcomeAt") == nil)
        #expect(!attention.isHeld(summary(at: 100)))
    }
}
