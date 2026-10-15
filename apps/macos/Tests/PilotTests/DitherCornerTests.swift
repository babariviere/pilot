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
    // Mid-recession renders are one-offs and never grow the cache; a fully receded corner is cached like a resting one.
    let before = DitherCornerRenderer.cachedCount
    var receding = request
    receding.recede = 0.4
    #expect(!receding.isCacheable)
    _ = DitherCornerRenderer.image(for: receding)
    #expect(DitherCornerRenderer.cachedCount == before)
    receding.recede = 1
    #expect(receding.isCacheable)
}

@Test func cornerIsDensestAtTheCornerAndEmptyFarFromIt() {
    for signal in SessionSignal.allCases {
        let corner = DitherCornerRenderer.coverage(signal, u: 0.5, v: 0.5, frame: 0, recede: 0)
        let far = DitherCornerRenderer.coverage(signal, u: 50, v: 20, frame: 0, recede: 0)
        #expect(corner > 0.4, "\(signal)")
        #expect(far == 0, "\(signal)")
    }
}

@Test func hoverRecedesTheCornerTowardTheTrailingEdge() {
    for signal in SessionSignal.allCases {
        // The densest cells stay; farther cells empty out, across and up, so revealed buttons get room.
        let corner = DitherCornerRenderer.coverage(signal, u: 0.5, v: 0.5, frame: 0, recede: 1)
        #expect(corner > 0.4, "\(signal)")
        for (u, v) in [(30.0, 2.0), (4.0, 15.0), (20.0, 10.0)] {
            let resting = DitherCornerRenderer.coverage(signal, u: u, v: v, frame: 0, recede: 0)
            let receded = DitherCornerRenderer.coverage(signal, u: u, v: v, frame: 0, recede: 1)
            #expect(resting > 0, "\(signal) \(u),\(v)")
            #expect(receded == 0, "\(signal) \(u),\(v)")
        }
        // Halfway is between the two. Working is left out: its ripple varies with distance, so a cell's level can
        // rise as the corner draws in.
        guard signal != .working else { continue }
        let half = DitherCornerRenderer.coverage(signal, u: 15, v: 5, frame: 0, recede: 0.5)
        #expect(half < DitherCornerRenderer.coverage(signal, u: 15, v: 5, frame: 0, recede: 0))
        #expect(half > DitherCornerRenderer.coverage(signal, u: 15, v: 5, frame: 0, recede: 1))
    }
}

@MainActor @Test func recededCornerKeepsItsCellSize() throws {
    let resting = try #require(DitherCornerRenderer.image(for: DitherCornerRequest(signal: .readyToMerge, previous: nil, frame: 0)))
    let receded = try #require(DitherCornerRenderer.image(for: DitherCornerRequest(signal: .readyToMerge, previous: nil,
                                                                                   frame: 0, recede: 1)))
    // Same grid, fewer drawn cells.
    #expect(receded.width == resting.width && receded.height == resting.height)
    func drawn(_ image: CGImage) throws -> Int {
        let data = try #require(image.dataProvider?.data as Data?)
        return stride(from: 3, to: data.count, by: 4).filter { data[$0] > 0 }.count
    }
    let restingCells = try drawn(resting)
    let recededCells = try drawn(receded)
    #expect(recededCells > 0 && recededCells < restingCells / 2)
}

@Test func onlyWorkingAndNeedsYouCornersMove() {
    #expect(DitherCorner.animates(.working))
    #expect(DitherCorner.animates(.needsYou))
    #expect(!DitherCorner.animates(.failed))
    #expect(!DitherCorner.animates(.readyToMerge))
    #expect(!DitherCorner.animates(nil))
    let a = DitherCornerRenderer.coverage(.failed, u: 10, v: 5, frame: 0, recede: 0)
    let b = DitherCornerRenderer.coverage(.failed, u: 10, v: 5, frame: 17, recede: 0)
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
    let small = DitherCornerRenderer.coverage(.needsYou, u: 10, v: 5, frame: 0, recede: 0)
    let large = DitherCornerRenderer.coverage(.needsYou, u: 25, v: 12.5, frame: 0, recede: 0, extent: 2.5)
    #expect(abs(small - large) < 0.000_001)
}
