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

@Test @MainActor func settledMovingCornersLoopTheirCachedClockFrames() {
    let working = DitherCornerLoopView.Loop(signal: .working, extent: ComposerCorner.extent)
    let frames = DitherCornerLoopView.frames(working)
    #expect(frames.count == DitherCorner.frameCount)
    #expect(abs(working.duration - 3) < 0.000_001)
    // The same images the clocked corner draws, from the renderer's cache.
    let clocked = DitherCornerRenderer.image(for: DitherCornerRequest(signal: .working, previous: nil, frame: 5,
                                                                        extent: ComposerCorner.extent))
    #expect(frames[5] === clocked)
    let background = DitherCornerLoopView.Loop(signal: .working, background: true, extent: ComposerCorner.extent)
    #expect(DitherCornerLoopView.frames(background).count == DitherCorner.backgroundFrameCount)
    let view = DitherCornerLoopView(frame: NSRect(x: 0, y: 0, width: 156, height: 72))
    view.loop = working
    #expect(!view.playing, "detached views hold their first frame")
    #expect(view.layer?.sublayers?.first?.contents != nil)
}

@Test @MainActor func recedingCornersCrossfadeTheirRestingAndRecededLoops() {
    let row = DitherCornerLoopView.Loop(signal: .working, recedes: true)
    let receded = DitherCornerLoopView.frames(row, receded: true)
    #expect(receded.count == DitherCorner.frameCount)
    // The receded loop is the renderer's cached fully receded frames, the pixels the clocked corner showed on hover.
    #expect(receded[7] === DitherCornerRenderer.image(for: DitherCornerRequest(signal: .working, previous: nil, frame: 7, recede: 1)))
    let view = DitherCornerLoopView(frame: NSRect(x: 0, y: 0, width: 104, height: 48))
    view.loop = row
    let layers = view.layer?.sublayers ?? []
    #expect(layers.count == 2)
    #expect(layers[1].contents != nil, "a receding row also holds its receded frame")
    view.setReceded(true, animated: false)
    #expect(view.receded && layers[0].opacity == 0 && layers[1].opacity == 1)
    view.setReceded(false, animated: false)
    #expect(layers[0].opacity == 1 && layers[1].opacity == 0)
    // Corners that never recede keep no receded frames.
    let composer = DitherCornerLoopView(frame: .zero)
    composer.loop = DitherCornerLoopView.Loop(signal: .working, extent: ComposerCorner.extent)
    #expect(composer.layer?.sublayers?[1].contents == nil)
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

@Test func composerCornerShowsWorkOnly() {
    func chat(state: String, working: Bool?, jobs: [SessionJob]? = nil, sleepPaused: Bool = false) -> SessionSummary {
        var session = SessionSummary(id: "c", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: state,
                                     runningJobs: jobs, working: working)
        session.sleepPaused = sleepPaused ? true : nil
        return session
    }
    let tests = [SessionJob(id: "t", name: "Tests", startedAt: 0, outputPath: "/tmp/t.log")]
    // The agent's own run: the full working ripple, with or without jobs.
    #expect(ComposerCorner(agentWorking: true, session: nil) == ComposerCorner(signal: .working))
    var offline = chat(state: "working", working: false)
    offline.offlinePaused = true
    #expect(ComposerCorner(agentWorking: true, session: offline).signal == nil)
    #expect(ComposerCorner(agentWorking: true, session: chat(state: "working", working: true, jobs: tests))
        == ComposerCorner(signal: .working))
    // Idle agent, background jobs running: the background ripple.
    let waiting = ComposerCorner(agentWorking: false, session: chat(state: "idle", working: true, jobs: tests))
    #expect(waiting == ComposerCorner(signal: .working, background: true))
    #expect(waiting.background)
    // Idle: nothing, including a paused chat whose jobs still exist.
    #expect(ComposerCorner(agentWorking: false, session: chat(state: "idle", working: false)).signal == nil)
    #expect(ComposerCorner(agentWorking: false, session: nil).signal == nil)
    #expect(ComposerCorner(agentWorking: false, session: chat(state: "idle", working: true, jobs: tests, sleepPaused: true))
        .signal == nil)
    // Background only applies to working.
    #expect(!ComposerCorner(signal: nil, background: true).background)
}

@MainActor @Test func composerCornerCacheStaysBounded() throws {
    let extent = ComposerCorner.extent
    let size = DitherCorner.grid(extent: extent)
    let first = try #require(DitherCornerRenderer.image(for: DitherCornerRequest(signal: .working, previous: nil, frame: 0,
                                                                                 extent: extent)))
    #expect(first.width == size.columns && first.height == size.rows)
    let before = DitherCornerRenderer.cachedCount
    // Two full clock loops of both ripples add at most one image per distinct loop frame.
    for _ in 0 ..< 2 {
        for frame in 0 ..< 2 * DitherCorner.backgroundFrameCount {
            for background in [false, true] {
                let request = DitherCornerRequest(signal: .working, previous: nil,
                                                  frame: DitherCorner.loopFrame(frame, background: background),
                                                  extent: extent, background: background)
                _ = DitherCornerRenderer.image(for: request)
            }
        }
    }
    #expect(DitherCornerRenderer.cachedCount - before <= DitherCorner.frameCount + DitherCorner.backgroundFrameCount)
    // Dissolves are one-offs and never enter the cache.
    let after = DitherCornerRenderer.cachedCount
    _ = DitherCornerRenderer.image(for: DitherCornerRequest(signal: nil, previous: .working, frame: 0, mix: 0.4, extent: extent))
    #expect(DitherCornerRenderer.cachedCount == after)
}
