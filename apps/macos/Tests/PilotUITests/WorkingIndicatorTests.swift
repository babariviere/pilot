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

@Test func dotGridHasSixteenFixedRoundDotsInAThirteenPointFrame() {
    #expect(DotGrid.side == 13)
    let rects = DotGrid.dotRects
    #expect(rects.count == 16)
    let frame = CGRect(x: 0, y: 0, width: DotGrid.side, height: DotGrid.side)
    for rect in rects {
        #expect(rect.width == 2.2 && rect.height == 2.2)
        #expect(frame.contains(rect))
    }
    // A 3.3 pt pitch across and down, centred in the frame.
    #expect(abs(rects[1].minX - rects[0].minX - 3.3) < 0.000_001)
    #expect(abs(rects[4].minY - rects[0].minY - 3.3) < 0.000_001)
    #expect(abs(rects[0].minX - (DotGrid.side - rects[15].maxX)) < 0.000_001)
    #expect(abs(rects[0].minY - (DotGrid.side - rects[15].maxY)) < 0.000_001)
}

@Test func dotGridWaveRunsDiagonallyAndLoopsInAboutOneAndAHalfSeconds() {
    #expect(abs(Double(DotGrid.frameCount) * DitherCorner.frameInterval - 1.5) < 0.000_001)
    // The shared clock counts to a multiple of both loops, so neither jumps when the clock wraps.
    #expect(DitherCorner.backgroundFrameCount % DotGrid.frameCount == 0)
    #expect(DitherCorner.backgroundFrameCount % DotGrid.backgroundFrameCount == 0)
    #expect(DotGrid.backgroundFrameCount == 2 * DotGrid.frameCount)
    var patterns = Set<[Double]>()
    for frame in 0 ..< DotGrid.frameCount {
        let levels = DotGrid.levels(frame: frame, background: false)
        #expect(levels.allSatisfy { (0 ... 1).contains($0) })
        // Dots on the same anti-diagonal share a phase.
        #expect(DotGrid.level(x: 1, y: 2, frame: frame, background: false)
            == DotGrid.level(x: 2, y: 1, frame: frame, background: false))
        patterns.insert(levels)
    }
    #expect(patterns.count >= 12)
    #expect(DotGrid.levels(frame: DotGrid.frameCount, background: false) == DotGrid.levels(frame: 0, background: false))
    // The crest reaches the top-left corner before the bottom-right one.
    func peak(_ x: Int, _ y: Int) -> Int {
        (0 ..< DotGrid.frameCount).max { DotGrid.level(x: x, y: y, frame: $0, background: false)
            < DotGrid.level(x: x, y: y, frame: $1, background: false) }!
    }
    #expect(peak(0, 0) < peak(3, 3))
}

@Test func backgroundDotGridIsFainterAndHalfAsFast() {
    func total(_ background: Bool) -> Double {
        (0 ..< DotGrid.backgroundFrameCount).reduce(0) { $0 + DotGrid.levels(frame: $1, background: background).reduce(0, +) }
    }
    #expect(total(true) < total(false) * 0.7)
    #expect(DotGrid.levels(frame: 0, background: true).allSatisfy { $0 <= DotGrid.backgroundPeak })
    #expect(DotGrid.backgroundRestOpacity < 1)
    // Frame 2n in the background matches frame n in the foreground, scaled.
    for frame in 0 ..< DotGrid.frameCount {
        let fast = DotGrid.levels(frame: frame, background: false)
        let slow = DotGrid.levels(frame: frame * 2, background: true)
        for (a, b) in zip(fast, slow) { #expect(abs(a * DotGrid.backgroundPeak - b) < 0.000_001) }
    }
    #expect(DotGrid.levels(frame: DotGrid.frameCount, background: true) != DotGrid.levels(frame: 0, background: true))
}

@Test func reduceMotionFrameHoldsTheCrestMidGrid() {
    for background in [false, true] {
        let still = DotGrid.levels(frame: DotGrid.stillFrame(background: background), background: background)
        // Some dots lit, others at rest, so a still grid still reads as the working mark.
        #expect(still.contains { $0 > 0.3 })
        #expect(still.contains { $0 == 0 })
        #expect(DotGrid.level(x: 0, y: 0, frame: DotGrid.stillFrame(background: background), background: background) == 0)
    }
}

@Test func elapsedScheduleTicksEachSecondThenEachMinute() {
    let start = Date(timeIntervalSince1970: 1000)
    let schedule = JobElapsedSchedule(startedAt: 1_000_000)
    let early = Array(schedule.entries(from: start.addingTimeInterval(58.5), mode: .normal).prefix(3))
    #expect(early.map { $0.timeIntervalSince(start) } == [58.5, 59, 60])
    let later = Array(schedule.entries(from: start.addingTimeInterval(61), mode: .normal).prefix(3))
    #expect(later.map { $0.timeIntervalSince(start) } == [61, 120, 180])
}
