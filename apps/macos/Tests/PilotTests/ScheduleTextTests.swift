import Foundation
import PilotCore
import Testing
@testable import Pilot

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let nowMs = now.timeIntervalSince1970 * 1000

private func item(_ id: String, state: ScheduleState = .pending, trigger: ScheduleTrigger = .onBack, at: Double? = nil,
                  networks: [String]? = nil,
                  project: String? = "p", target: ScheduleTarget = .chat(SpawnRequest(projectId: "p", message: "Fix it")),
                  sessionId: String? = nil, error: String? = nil, createdAt: Double = 1, updatedAt: Double = 1) -> ScheduledItem {
    ScheduledItem(id: id, revision: 1, title: id, projectId: project, trigger: trigger, at: at, networkNames: networks,
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

@Test func wifiRowsNameTheirNetworks() {
    #expect(ScheduleText.choices.contains(.onJoinNetwork) && ScheduleText.choices.contains(.onLeaveNetwork))
    #expect(ScheduleText.when(item("a", trigger: .onJoinNetwork, networks: ["Office"])) == "When I join Office")
    #expect(ScheduleText.when(item("b", trigger: .onLeaveNetwork, networks: ["Office", "Home"])) == "When I leave Office or Home")
    let many = item("c", trigger: .onJoinNetwork, networks: ["Office", "Home", "Café"])
    #expect(ScheduleText.when(many) == "When I join Office or 2 others")
    #expect(ScheduleText.when(many, full: true) == "When I join Office, Home or Café")
    let long = item("d", trigger: .onLeaveNetwork, networks: ["Corporate Guest Network 5G"])
    #expect(ScheduleText.when(long) == "When I leave Corporate Guest Net…")
    #expect(ScheduleText.when(long, full: true) == "When I leave Corporate Guest Network 5G")
    #expect(ScheduleText.when(item("e", trigger: .onJoinNetwork)) == "When I join a network")
}

@Test func wifiPickerPutsTheConnectedNetworkFirst() {
    let status = WiFiStatus(authorization: .authorized, available: true, currentNetwork: "Office",
                            knownNetworks: ["home", "Office", "Café", "Airport"])
    #expect(ScheduleText.networkChoices(status, selected: ["Gone", "home"]) == ["Office", "Airport", "Café", "home", "Gone"])
    let off = WiFiStatus(authorization: .authorized, available: false, currentNetwork: "Office", knownNetworks: ["Home"])
    #expect(ScheduleText.networkChoices(off) == ["Home"])
}

@Test func wifiHintsSayWhenTheConditionAlreadyHolds() {
    let onOffice = WiFiStatus(authorization: .authorized, available: true, currentNetwork: "Office", knownNetworks: ["Office", "Home"])
    #expect(ScheduleText.networkHint(.onJoinNetwork, selected: ["Office"], status: onOffice)?.contains("on Office now") == true)
    #expect(ScheduleText.networkHint(.onJoinNetwork, selected: ["Home"], status: onOffice) == nil)
    #expect(ScheduleText.networkHint(.onLeaveNetwork, selected: ["Office"], status: onOffice) == nil)
    #expect(ScheduleText.networkHint(.onLeaveNetwork, selected: ["Home"], status: onOffice)?.contains("isn’t on Home now") == true)
    #expect(ScheduleText.networkHint(.onLeaveNetwork, selected: ["Home", "Café"], status: onOffice)?.contains("these networks") == true)
    // Without access the current network is unknown, so nothing is claimed.
    let denied = WiFiStatus(authorization: .denied, available: true)
    #expect(ScheduleText.networkHint(.onLeaveNetwork, selected: ["Home"], status: denied) == nil)
    #expect(ScheduleText.networkHint(.onJoinNetwork, selected: [], status: onOffice) == nil)
    #expect(ScheduleText.wifiAccessMessage(onOffice) == nil)
    #expect(ScheduleText.wifiAccessMessage(denied)?.contains("Pilot Wi-Fi") == true)
}
