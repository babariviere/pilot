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
    for outcome in [SessionOutcome.done, .failed, .stopped] {
        let session = summary(outcome: outcome, at: 1234, reason: "Turn completed")
        let encoded = try JSONEncoder().encode(session)
        #expect(String(decoding: encoded, as: UTF8.self).contains("\"outcome\":\"\(outcome.rawValue)\""))
        #expect(try JSONDecoder().decode(SessionSummary.self, from: encoded) == session)
    }
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

@Test func reviewRequiresVisibleActiveChatOrExplicitActionAndPersists() {
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
        #expect(reopened.review(summary(at: 101), chatVisible: false, appActive: false, explicit: true))
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
