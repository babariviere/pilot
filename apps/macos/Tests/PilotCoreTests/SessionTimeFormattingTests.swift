import Foundation
import Testing
@testable import PilotCore

@Test func sessionAgeUsesMillisecondsAndAdvancesWithoutNewActivity() {
    let milliseconds = 1_710_000_000_000.0
    let timestamp = Date(timeIntervalSince1970: milliseconds / 1_000)
    let cases: [(TimeInterval, String)] = [
        (-60, "now"), (0, "now"), (59, "now"), (60, "1m"), (3_599, "59m"),
        (3_600, "1h"), (86_399, "23h"), (86_400, "1d"), (604_799, "6d"),
        (604_800, "1w"), (1_209_600, "2w"),
    ]
    for (age, expected) in cases {
        #expect(SessionTimeFormatting.relative(milliseconds, now: timestamp.addingTimeInterval(age)) == expected)
    }
}
