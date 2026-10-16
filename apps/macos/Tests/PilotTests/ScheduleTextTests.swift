import Foundation
import PilotCore
import Testing
@testable import Pilot

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let nowMs = now.timeIntervalSince1970 * 1000

private func item(_ id: String, state: ScheduleState = .pending, trigger: ScheduleTrigger = .onBack, at: Double? = nil,
                  project: String? = "p", target: ScheduleTarget = .chat(SpawnRequest(projectId: "p", message: "Fix it")),
                  sessionId: String? = nil, error: String? = nil, createdAt: Double = 1, updatedAt: Double = 1) -> ScheduledItem {
    ScheduledItem(id: id, revision: 1, title: id, projectId: project, trigger: trigger, at: at,
                  target: target, state: state, createdAt: createdAt, updatedAt: updatedAt, sessionId: sessionId, error: error)
}

@Test func scheduleRowsSayWhenAndWhatWillStart() {
    #expect(ScheduleText.when(item("a"), now: now) == "When I’m back")
    #expect(ScheduleText.when(item("b", trigger: .onOnline), now: now) == "When online")
    #expect(ScheduleText.when(item("c", trigger: .at, at: nowMs + 3_600_000), now: now).hasPrefix("Today "))
    #expect(ScheduleText.when(item("d", trigger: .at, at: nowMs + 86_400_000), now: now).hasPrefix("Tomorrow "))
    let ask = item("e", target: .chat(SpawnRequest(projectId: "p", message: "Explain", mode: .ask)))
    #expect(ScheduleText.detail(ask, projectName: "pilot") == "New chat · pilot · Ask")
    #expect(ScheduleText.detail(item("f")) == "New chat")
    let followUp = item("g", target: .message(sessionId: "s", message: "Continue"))
    #expect(ScheduleText.detail(followUp, chatTitle: "Fix login") == "Follow-up in Fix login")
    #expect(ScheduleText.detail(followUp) == "Follow-up message")
    let failed = item("h", state: .failed, error: "Project is missing\nstack")
    #expect(ScheduleText.detail(failed) == "Couldn’t start: Project is missing")
    #expect(ScheduleText.detail(item("i", state: .failed)) == "Couldn’t start.")
}

@Test func scheduleTitlesUseTheFirstLineOfThePrompt() {
    #expect(ScheduleText.title("\n  Fix the login flow  \nDetails", fallback: "New chat") == "Fix the login flow")
    #expect(ScheduleText.title("   \n ", fallback: "New chat") == "New chat")
    let long = ScheduleText.title(String(repeating: "a", count: 200), fallback: "x")
    #expect(long.count == 80 && long.hasSuffix("…"))
}

@Test func scheduleListsPutFailuresFirstThenTheNextToStart() {
    let items = [
        item("late", trigger: .at, at: 5_000, createdAt: 1),
        item("early", createdAt: 2_000),
        item("failedOld", state: .failed, updatedAt: 10),
        item("failedNew", state: .failed, updatedAt: 20),
        item("fired", state: .fired),
        item("cancelled", state: .cancelled),
        item("other", project: "q", createdAt: 1),
    ]
    #expect(ScheduleText.listed(items, includeFailed: true).map(\.id)
        == ["failedNew", "failedOld", "other", "early", "late"])
    #expect(ScheduleText.listed(items, projectId: "p", includeFailed: false).map(\.id) == ["early", "late"])
}

@Test func chatFollowUpsOnlyListPendingMessagesForThatChat() {
    let items = [
        item("mine", target: .message(sessionId: "s", message: "Continue")),
        item("sent", state: .fired, target: .message(sessionId: "s", message: "Done")),
        item("other", target: .message(sessionId: "t", message: "Elsewhere")),
        item("chat", sessionId: "s"),
    ]
    #expect(ScheduleText.followUps(items, sessionId: "s").map(\.id) == ["mine"])
}

@Test func scheduleNotificationsOnlyFollowObservedTransitions() {
    let started = item("Fix login", state: .fired, sessionId: "s")
    #expect(ScheduleText.notification(started, previous: .pending, chatTitle: nil)?.title == "Scheduled chat started")
    #expect(ScheduleText.notification(started, previous: .dispatching, chatTitle: nil)?.body == "Fix login")
    // The first list after launch, and repeated lists, are a baseline.
    #expect(ScheduleText.notification(started, previous: nil, chatTitle: nil) == nil)
    #expect(ScheduleText.notification(started, previous: .fired, chatTitle: nil) == nil)
    let failed = item("Continue", state: .failed, target: .message(sessionId: "s", message: "Continue"),
                      error: "Chat is archived")
    let text = ScheduleText.notification(failed, previous: .dispatching, chatTitle: "Fix login")
    #expect(text?.title == "Scheduled message couldn’t be sent")
    #expect(text?.body == "Fix login: Continue. Chat is archived")
    #expect(ScheduleText.notification(item("x", state: .cancelled), previous: .pending, chatTitle: nil) == nil)
}

@Test func scheduleSheetSuggestsTheNextWholeHourAtLeastHalfAnHourAway() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let base = calendar.date(from: DateComponents(year: 2026, month: 10, day: 13, hour: 21, minute: 40))!
    let suggested = ScheduleSheet.suggestedTime(now: base, calendar: calendar)
    #expect(calendar.dateComponents([.hour, .minute], from: suggested) == DateComponents(hour: 23, minute: 0))
}

@Test func scheduleSheetSendsWholeMillisecondsAtTheStartOfTheMinute() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let minute = calendar.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 19, minute: 10))!
    let picked = minute.addingTimeInterval(37.1234567)
    let at = ScheduleSheet.epochMilliseconds(picked, calendar: calendar)
    #expect(at == minute.timeIntervalSince1970 * 1000)
    #expect(at == at.rounded())
}

@Test func scheduleChoicesOfferOnlyLiveTriggers() {
    #expect(ScheduleText.choices == [.onBack, .onOnline, .at])
    #expect(!ScheduleText.choices.contains(.removed) && !ScheduleText.choices.contains(.onWake))
    #expect(ScheduleText.when(item("w", trigger: .onWake), now: now) == "After wake")
}

@Test func removedTriggersReadAsCancelledTombstones() {
    let removed = item("r", trigger: .removed)
    #expect(removed.state == .cancelled)
    #expect(ScheduleText.when(removed, now: now) == "Removed trigger")
    #expect(ScheduleText.label(.removed) == "Removed trigger")
    // Cancelled tombstones are never listed as pending work or follow-ups.
    #expect(ScheduleText.listed([removed], includeFailed: true).isEmpty)
    let followUp = item("m", trigger: .removed, target: .message(sessionId: "s", message: "Later"))
    #expect(ScheduleText.followUps([followUp], sessionId: "s").isEmpty)
}
