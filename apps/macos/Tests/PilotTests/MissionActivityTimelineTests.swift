import Foundation
import Testing
@testable import Pilot
@testable import PilotCore

private func event(_ id: Int, at date: Date) -> MissionEvent {
    MissionEvent(id: id, kind: .update, text: "Event \(id)", sessionId: nil, taskId: nil, health: nil,
                 at: date.timeIntervalSince1970 * 1000)
}

@Test func activityDaysGroupConsecutiveEventsNewestFirst() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let today = calendar.startOfDay(for: now)
    let events = [
        event(5, at: today.addingTimeInterval(7200)),
        event(4, at: today.addingTimeInterval(60)),
        event(3, at: today.addingTimeInterval(-60)),
        event(2, at: today.addingTimeInterval(-3600)),
        event(1, at: today.addingTimeInterval(-86_400 * 3)),
    ]
    let days = MissionActivityDay.group(events, now: now, calendar: calendar)
    #expect(days.map(\.title).prefix(2) == ["Today", "Yesterday"])
    #expect(days.map { $0.events.map(\.id) } == [[5, 4], [3, 2], [1]])
}

@Test @MainActor func largeMissionFixtureMatchesTheProfiledSize() {
    let fixture = MissionTabsFixture()
    #expect(fixture.detail.tasks.count == 100)
    #expect(fixture.detail.events.count == 1000)
    #expect((fixture.detail.brief?.markdown.utf8.count ?? 0) >= 50_000)
}
