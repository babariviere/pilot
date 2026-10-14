import Foundation
import PilotCore
import Testing
@testable import Pilot

private func calendar(_ zone: String = "UTC") -> Calendar {
    var value = Calendar(identifier: .gregorian)
    value.timeZone = TimeZone(identifier: zone)!
    return value
}

private func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

private func activityChat(_ id: String, at: Date, archived: Bool = false) -> SessionSummary {
    SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: at.timeIntervalSince1970 * 1000,
                   updatedAt: at.timeIntervalSince1970 * 1000, state: "idle",
                   archivedAt: archived ? at.timeIntervalSince1970 * 1000 + 1 : nil,
                   workspaceStorage: .shared, workspaceReclaimedAt: archived ? 1 : nil)
}

@Test @MainActor func activityRetainsArchivedAndReclaimedSessionsAcrossLiveUpdates() {
    let client = PilotClient()
    let now = date("2026-10-14T12:00:00Z")
    let today = activityChat("today", at: now)
    let yesterday = activityChat("yesterday", at: date("2026-10-13T12:00:00Z"), archived: true)
    client.handle(.sessions([today, yesterday]))
    let before = client.activityDays(now: now, calendar: calendar()).map(\.count)
    #expect(before.suffix(2) == [1, 1])
    client.handle(.session(activityChat("today", at: now, archived: true)))
    #expect(client.activeSessions.isEmpty)
    #expect(client.sessions.count == 2)
    #expect(client.activityDays(now: now, calendar: calendar()).map(\.count) == before)
    client.handle(.session(today))
    #expect(client.activityDays(now: now, calendar: calendar()).map(\.count) == before)
}

@Test @MainActor func activityIncludesExactlyFourteenLocalCalendarDaysAcrossDST() {
    let client = PilotClient()
    let now = date("2026-03-10T12:00:00Z")
    // New York changed from UTC-5 to UTC-4 on March 8.
    let first = date("2026-02-25T05:00:00Z")
    let end = date("2026-03-11T04:00:00Z")
    client.handle(.sessions([
        activityChat("too-old", at: first.addingTimeInterval(-0.001)),
        activityChat("first", at: first, archived: true),
        activityChat("before-DST", at: date("2026-03-08T04:59:59Z")),
        activityChat("DST-start", at: date("2026-03-08T05:00:00Z")),
        activityChat("next-midnight", at: date("2026-03-09T04:00:00Z")),
        activityChat("last", at: end.addingTimeInterval(-0.001)),
        activityChat("future", at: end),
    ]))
    let days = client.activityDays(now: now, calendar: calendar("America/New_York"))
    #expect(days.count == 14)
    #expect(days.first?.count == 1 && days.last?.count == 1)
    #expect(days.map(\.count).suffix(4) == [1, 1, 1, 1])
    #expect(days.map(\.count).reduce(0, +) == 5)
}

@Test @MainActor func activityHandlesEmptyAndLargeHistories() {
    let client = PilotClient()
    let now = date("2026-10-14T12:00:00Z")
    #expect(client.activityDays(now: now, calendar: calendar()).map(\.count) == Array(repeating: 0, count: 14))
    client.handle(.sessions((0 ..< 10_000).map { activityChat("\($0)", at: now, archived: $0.isMultiple(of: 2)) }))
    let days = client.activityDays(now: now, calendar: calendar())
    #expect(days.last?.count == 10_000)
    #expect(days.map(\.count).reduce(0, +) == 10_000)
}
