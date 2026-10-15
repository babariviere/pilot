import Foundation
import PilotCore
import Testing

@Test func relativeDateReadsTheSameMomentTheSameWay() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let nowMs = now.timeIntervalSince1970 * 1000
    #expect(RelativeDate.ago(nowMs - 10_000, now: now) == "just now")
    #expect(RelativeDate.ago(nowMs - 12 * 60_000, now: now) == "12m ago")
    #expect(RelativeDate.ago(nowMs - 3 * 86_400_000, now: now) == "3d ago")
    // Clock skew never reads as the future.
    #expect(RelativeDate.ago(nowMs + 60_000, now: now) == "just now")
    let english = Locale(identifier: "en_US")
    #expect(RelativeDate.sentence(nowMs - 30_000, now: now, locale: english) == "just now")
    #expect(RelativeDate.sentence(nowMs - 3 * 60_000, now: now, locale: english) == "3 minutes ago")
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let noon = calendar.date(from: DateComponents(year: 2026, month: 10, day: 15, hour: 12))!
    #expect(RelativeDate.upcoming(noon.addingTimeInterval(3_600), now: noon, calendar: calendar).hasPrefix("Today "))
    #expect(RelativeDate.upcoming(noon.addingTimeInterval(86_400), now: noon, calendar: calendar).hasPrefix("Tomorrow "))
    #expect(!RelativeDate.exact(nowMs).isEmpty)
}
