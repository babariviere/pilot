import AppKit
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func restingCornersAreCachedAndQuietRowsDrawNothing() throws {
    #expect(DitherCornerRenderer.image(for: DitherCornerRequest(signal: nil, previous: nil, frame: 0)) == nil)
    let request = DitherCornerRequest(signal: .failed, previous: nil, frame: 3)
    let first = try #require(DitherCornerRenderer.image(for: request))
    let second = try #require(DitherCornerRenderer.image(for: request))
    #expect(first === second)
    #expect(first.width == DitherCorner.columns && first.height == DitherCorner.rows)
    // Hover renders are one-offs and never grow the cache.
    let before = DitherCornerRenderer.cachedCount
    var hovering = request
    hovering.hover = 1
    hovering.leanX = -12
    _ = DitherCornerRenderer.image(for: hovering)
    #expect(DitherCornerRenderer.cachedCount == before)
}

@Test func cornerIsDensestAtTheCornerAndEmptyFarFromIt() {
    for signal in SessionSignal.allCases {
        let corner = DitherCornerRenderer.coverage(signal, u: 0.5, v: 0.5, frame: 0, lean: (0, 0), hover: 0)
        let far = DitherCornerRenderer.coverage(signal, u: 50, v: 20, frame: 0, lean: (0, 0), hover: 0)
        #expect(corner > 0.4, "\(signal)")
        #expect(far == 0, "\(signal)")
    }
}

@Test func hoverLeansTheCornerTowardThePointer() {
    // A point up and to the left of the corner gains coverage when the pointer is there.
    let resting = DitherCornerRenderer.coverage(.readyToMerge, u: 30, v: 10, frame: 0, lean: (0, 0), hover: 0)
    let lean = DitherCorner.lean(pointer: CGPoint(x: 40, y: 4), in: CGSize(width: 220, height: 38))
    #expect(lean.x < 0 && lean.y < 0)
    #expect(lean.x >= -DitherCorner.maximumLean.x && lean.y >= -DitherCorner.maximumLean.y)
    let leaning = DitherCornerRenderer.coverage(.readyToMerge, u: 30, v: 10, frame: 0, lean: (lean.x, lean.y), hover: 1)
    #expect(leaning > resting)
    // A pointer at the corner itself does not lean.
    #expect(DitherCorner.lean(pointer: CGPoint(x: 220, y: 38), in: CGSize(width: 220, height: 38)) == .zero)
}

@Test func onlyWorkingAndNeedsYouCornersMove() {
    #expect(DitherCorner.animates(.working))
    #expect(DitherCorner.animates(.needsYou))
    #expect(!DitherCorner.animates(.failed))
    #expect(!DitherCorner.animates(.readyToMerge))
    #expect(!DitherCorner.animates(nil))
    let a = DitherCornerRenderer.coverage(.failed, u: 10, v: 5, frame: 0, lean: (0, 0), hover: 0)
    let b = DitherCornerRenderer.coverage(.failed, u: 10, v: 5, frame: 17, lean: (0, 0), hover: 0)
    #expect(a == b)
}

@Test @MainActor func cornerClockRunsOnlyWhileSubscribed() {
    let clock = DitherCornerClock.shared
    let id = UUID()
    let baseline = clock.subscriberCount
    clock.subscribe(id)
    #expect(clock.isRunning)
    #expect(clock.subscriberCount == baseline + 1)
    clock.unsubscribe(id)
    #expect(clock.subscriberCount == baseline)
    if baseline == 0 { #expect(!clock.isRunning) }
}

@MainActor @Test func largerExtentsAddCellsAndKeepTheirShape() {
    let request = DitherCornerRequest(signal: .needsYou, previous: nil, frame: 0, extent: 2.5)
    let image = DitherCornerRenderer.image(for: request)
    #expect(image?.width == 130 && image?.height == 60)
    // The same relative point is as dense at both sizes.
    let small = DitherCornerRenderer.coverage(.needsYou, u: 10, v: 5, frame: 0, lean: (0, 0), hover: 0)
    let large = DitherCornerRenderer.coverage(.needsYou, u: 25, v: 12.5, frame: 0, lean: (0, 0), hover: 0, extent: 2.5)
    #expect(abs(small - large) < 0.000_001)
}
