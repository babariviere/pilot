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

@Test func ellipsisHasThreeRoundDotsCentredInAThirteenPointFrame() {
    #expect(EllipsisDots.side == 13)
    let frame = CGRect(x: 0, y: 0, width: EllipsisDots.side, height: EllipsisDots.side)
    let rects = (0 ..< EllipsisDots.count).map { EllipsisDots.dotRect($0) }
    #expect(rects.count == 3)
    for rect in rects {
        #expect(rect.width == 2.9 && rect.height == 2.9)
        #expect(frame.contains(rect))
        #expect(abs(rect.midY - EllipsisDots.side / 2) < 0.000_001)
        #expect(frame.contains(EllipsisDots.dotRect(0, level: 1)))
    }
    #expect(abs(rects[1].minX - rects[0].minX - 4.3) < 0.000_001)
    #expect(abs(rects[0].minX - (EllipsisDots.side - rects[2].maxX)) < 0.000_001)
    // A lit dot rises.
    #expect(EllipsisDots.dotRect(1, level: 1).minY < rects[1].minY)
}

@Test func ellipsisPulsesLeftToRightAndLoopsInAboutOneAndAHalfSeconds() {
    #expect(abs(Double(EllipsisDots.frameCount) * DitherCorner.frameInterval - 1.5) < 0.000_001)
    // The shared clock counts to a multiple of both loops, so neither jumps when the clock wraps.
    #expect(DitherCorner.backgroundFrameCount % EllipsisDots.frameCount == 0)
    #expect(DitherCorner.backgroundFrameCount % EllipsisDots.backgroundFrameCount == 0)
    #expect(EllipsisDots.backgroundFrameCount == 2 * EllipsisDots.frameCount)
    for frame in 0 ..< EllipsisDots.frameCount {
        #expect(EllipsisDots.levels(frame: frame, background: false).allSatisfy { (0 ... 1).contains($0) })
    }
    #expect(EllipsisDots.levels(frame: EllipsisDots.frameCount, background: false)
        == EllipsisDots.levels(frame: 0, background: false))
    func peak(_ index: Int) -> Int {
        (0 ..< EllipsisDots.frameCount).max { EllipsisDots.level(index, frame: $0, background: false)
            < EllipsisDots.level(index, frame: $1, background: false) }!
    }
    #expect(peak(0) < peak(1) && peak(1) < peak(2))
    #expect(abs(EllipsisDots.level(0, frame: peak(0), background: false) - 1) < 0.000_001)
    // The loop ends with all three at rest.
    #expect(EllipsisDots.levels(frame: EllipsisDots.frameCount - 1, background: false).allSatisfy { $0 == 0 })
}

@Test func backgroundEllipsisIsFainterAndHalfAsFast() {
    #expect(EllipsisDots.backgroundRestOpacity < 1)
    // Frame 2n in the background matches frame n in the foreground, scaled.
    for frame in 0 ..< EllipsisDots.frameCount {
        let fast = EllipsisDots.levels(frame: frame, background: false)
        let slow = EllipsisDots.levels(frame: frame * 2, background: true)
        for (a, b) in zip(fast, slow) { #expect(abs(a * EllipsisDots.backgroundPeak - b) < 0.000_001) }
    }
    for frame in 0 ..< EllipsisDots.backgroundFrameCount {
        #expect(EllipsisDots.levels(frame: frame, background: true).allSatisfy { $0 <= EllipsisDots.backgroundPeak })
    }
}

@Test func ellipsisKeyframesFollowTheClockedPulseAtTheDisplayRate() {
    for background in [false, true] {
        let frames = background ? EllipsisDots.backgroundFrameCount : EllipsisDots.frameCount
        #expect(abs(EllipsisDots.loopDuration(background: background) - Double(frames) * DitherCorner.frameInterval) < 0.000_001)
        for index in 0 ..< EllipsisDots.count {
            let levels = EllipsisDots.keyframeLevels(index, background: background)
            #expect(levels.count == frames * 6 + 1)
            #expect(levels.first == levels.last, "the loop closes without a jump")
            // Every former clock frame is one of the keyframes, so the look is unchanged, only smoother.
            for frame in 0 ..< frames {
                #expect(abs(levels[frame * 6] - EllipsisDots.level(index, frame: frame, background: background)) < 0.000_001)
            }
        }
    }
}

@Test @MainActor func ellipsisPlaysOnLayersOnlyWhileVisibleAndAnimating() {
    let view = EllipsisSpinnerView(frame: NSRect(x: 0, y: 0, width: 26, height: 26))
    #expect(!view.playing, "no window, nothing plays")
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 80, height: 80), styleMask: [.titled],
                          backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView?.addSubview(view)
    view.layout()
    let dots = view.layer?.sublayers?.first?.sublayers ?? []
    #expect(dots.count == 3)
    // Scaled to the view, the frame stays fixed: motion is a transform inside it.
    #expect(abs((view.layer?.sublayers?.first?.transform.m11 ?? 0) - 2) < 0.000_001)
    view.animates = false
    #expect(!view.playing)
    #expect(dots.allSatisfy { $0.animationKeys() == nil })
    window.close()
}

@Test @MainActor func layerLoopsShareTheirPhaseAcrossViews() {
    let now = Date(timeIntervalSinceReferenceDate: 1000.25)
    let a = LoopingLayerView.sharedBeginTime(duration: 1.5, now: now)
    let b = LoopingLayerView.sharedBeginTime(duration: 1.5, now: now)
    #expect(abs(a - b) < 0.01)
    let animation = LoopingLayerView.loop("contents", values: [1, 2, 3], duration: 3, discrete: true)
    #expect(animation.keyTimes?.count == 4)
    #expect(animation.calculationMode == .discrete)
    #expect(animation.repeatCount == .infinity)
    let smooth = LoopingLayerView.loop("opacity", values: [0, 1, 0], duration: 1.5)
    #expect(smooth.keyTimes?.map(\.doubleValue) == [0, 0.5, 1])
}

@Test func reduceMotionFrameHoldsTheMiddleDotLit() {
    for background in [false, true] {
        let still = EllipsisDots.levels(frame: EllipsisDots.stillFrame(background: background), background: background)
        #expect(still[1] > 0.4)
        #expect(still[0] == 0 && still[2] == 0)
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
