import AppKit
import PilotCore
import Testing
@testable import Pilot

private func job(_ id: String, startedAt: Double) -> SessionJob {
    SessionJob(id: id, name: id.capitalized, startedAt: startedAt, outputPath: "/tmp/\(id).log")
}

@Test func workingLineKeepsWorkingAndRetryLabels() {
    #expect(WorkingIndicator(retry: nil).label == "Working…")
    #expect(WorkingIndicator(retry: "Rate limited").label == "Retrying: Rate limited")
    #expect(WorkingIndicator(retry: nil, compacting: true).label == "Compacting context…")
    #expect(WorkingIndicator(retry: nil, jobs: [job("tests", startedAt: 0)]).label == "Working… · 1 job")
}

@Test @MainActor func rippleFramesAreCachedAndTheBackgroundRippleIsFainter() throws {
    let first = try #require(DitherRippleRenderer.image(frame: 3, background: false))
    #expect(DitherRippleRenderer.image(frame: 3, background: false) === first)
    #expect(first.width == DitherRipple.columns && first.height == DitherRipple.rows)
    var active = 0.0, background = 0.0
    for frame in 0 ..< DitherCorner.backgroundFrameCount {
        for y in 0 ..< DitherRipple.rows {
            for x in 0 ..< DitherRipple.columns {
                active += DitherRippleRenderer.coverage(x: x, y: y, frame: frame % DitherCorner.frameCount, background: false)
                background += DitherRippleRenderer.coverage(x: x, y: y, frame: frame, background: true)
            }
        }
    }
    #expect(background < active * 0.7)
}

@Test func rippleMovesAndTheBackgroundRippleLoopsAtHalfSpeed() {
    let a = DitherRippleRenderer.coverage(x: 8, y: 3, frame: 0, background: false)
    let b = DitherRippleRenderer.coverage(x: 8, y: 3, frame: 9, background: false)
    #expect(a != b)
    // A loop takes twice as many clock frames in the background.
    func level(_ frame: Int, _ background: Bool) -> Double {
        DitherRippleRenderer.coverage(x: 5, y: 3, frame: frame, background: background)
    }
    #expect(abs(level(DitherCorner.frameCount, false) - level(0, false)) < 0.000_001)
    #expect(abs(level(DitherCorner.frameCount, true) - level(0, true)) > 0.01)
    #expect(abs(level(DitherCorner.backgroundFrameCount, true) - level(0, true)) < 0.000_001)
    #expect(DitherCorner.loopFrame(40, background: false) == 4)
    #expect(DitherCorner.loopFrame(40, background: true) == 40)
}

@Test func elapsedScheduleTicksEachSecondThenEachMinute() {
    let start = Date(timeIntervalSince1970: 1000)
    let schedule = JobElapsedSchedule(startedAt: 1_000_000)
    let early = Array(schedule.entries(from: start.addingTimeInterval(58.5), mode: .normal).prefix(3))
    #expect(early.map { $0.timeIntervalSince(start) } == [58.5, 59, 60])
    let later = Array(schedule.entries(from: start.addingTimeInterval(61), mode: .normal).prefix(3))
    #expect(later.map { $0.timeIntervalSince(start) } == [61, 120, 180])
}
