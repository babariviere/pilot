import Foundation
import PilotVisualsKit
import Testing
@testable import Pilot
@testable import PilotCore

/// Answers like the visual service for one visual whose root is a canvas; draws answer with the requested time, or
/// time out while timeouts are left.
private final class CanvasTransport: VisualTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [VisualDrawRequest] = []
    private var timeoutsLeft = 0
    let animated: Bool

    init(animated: Bool) {
        self.animated = animated
    }

    var draws: [VisualDrawRequest] { lock.withLock { requests } }

    func timeOut(_ count: Int) {
        lock.withLock { timeoutsLeft = count }
    }

    func send(_ message: VisualMessage) async -> Result<Data, VisualFailure> {
        let tree: VisualValue = ["api": 1, "root": ["type": "canvas", "id": "0", "height": 100,
                                                     "animated": .bool(animated)]]
        return .success(VisualWire.encode(["ok": true, "tree": tree, "state": "[]"]))
    }

    func draw(_ id: String, _ request: VisualDrawRequest) async -> Result<Data, VisualFailure> {
        let timeout = lock.withLock {
            requests.append(request)
            guard timeoutsLeft > 0 else { return false }
            timeoutsLeft -= 1
            return true
        }
        try? await Task.sleep(for: .milliseconds(5))
        if timeout { return .success(VisualReply.error(.timeout, "the drawing took longer than 8 ms")) }
        return .success(VisualDrawing(commands: 1, ops: [4, request.time], strings: []).encoded)
    }

    func release(_ id: String) {}
}

@MainActor
private func loadedModel(_ transport: CanvasTransport) async throws -> VisualArtifactModel {
    let model = VisualArtifactModel(engine: VisualEngineClient(transport: transport))
    let revision = ArtifactRevision(
        id: "canvas-\(UUID().uuidString)", sessionId: "s", projectId: nil, title: "Canvas", kind: .visual, revision: 1,
        createdAt: 1, updatedAt: 1, source: "({ ui }) => () => ui.canvas({ draw() {} })", html: "", libraries: [],
        data: .null, visual: ArtifactVisual(api: 1, engine: "quickjs-ng 0.17.0"))
    model.start(revision: revision, memoryKey: revision.id)
    try await waitFor { model.tree != nil }
    return model
}

@MainActor
private func waitFor(_ condition: () -> Bool) async throws {
    for _ in 0..<500 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(5))
    }
    Issue.record("timed out")
}

@MainActor
struct VisualCanvasDrawerTests {
    let canvas = VisualNode.Canvas(height: 100, animated: false, label: nil)

    @Test func drawsWhenVisibleAndMergesRequestsWhileOneIsInFlight() async throws {
        let transport = CanvasTransport(animated: false)
        let model = try await loadedModel(transport)
        let drawer = VisualCanvasDrawer(clock: VisualDisplayClock(usesDisplayLink: false))
        drawer.configure(model: model, path: "0", canvas: canvas, reduceMotion: false)
        drawer.resize(CGSize(width: 300, height: 100))
        // The first frame draws even before the canvas is on screen, so it never shows empty when it appears.
        try await waitFor { drawer.output.drawing != nil }
        drawer.setVisible(true)
        drawer.resize(CGSize(width: 400, height: 100))
        drawer.point(CGPoint(x: 10, y: 20))
        drawer.point(CGPoint(x: 30, y: 40))
        try await waitFor { transport.draws.last?.pointer == VisualPoint(x: 30, y: 40) }
        try await Task.sleep(for: .milliseconds(30))
        // One for the first frame, one for the resize, then the latest pointer once.
        #expect(transport.draws.count <= 3)
        #expect(transport.draws.last?.width == 400)
        #expect(transport.draws.allSatisfy { $0.time == 0 && $0.canvas == "0" && $0.height == 100 })
        // Leaving the canvas stops pointer draws; hidden canvases don't draw again.
        drawer.setVisible(false)
        let count = transport.draws.count
        drawer.point(nil)
        try await Task.sleep(for: .milliseconds(30))
        #expect(transport.draws.count == count)
    }

    @Test func animatesOnlyWhileVisibleOnTheSharedClock() async throws {
        let transport = CanvasTransport(animated: true)
        let model = try await loadedModel(transport)
        let clock = VisualDisplayClock(usesDisplayLink: false)
        let drawer = VisualCanvasDrawer(clock: clock)
        let animated = VisualNode.Canvas(height: 100, animated: true, label: nil)
        drawer.configure(model: model, path: "0", canvas: animated, reduceMotion: false)
        drawer.resize(CGSize(width: 300, height: 100))
        #expect(clock.subscriberCount == 0)
        drawer.setVisible(true)
        #expect(clock.subscriberCount == 1)
        try await waitFor { drawer.output.drawing != nil }
        clock.fire(10)
        clock.fire(10.5)
        try await waitFor { transport.draws.contains { $0.time == 0.1 } }
        // A half-second gap advances a tenth of a second at most.
        #expect(transport.draws.map(\.time).max() == 0.1)
        drawer.setVisible(false)
        #expect(clock.subscriberCount == 0)
        // Reduce Motion holds the first frame.
        drawer.setVisible(true)
        drawer.configure(model: model, path: "0", canvas: animated, reduceMotion: true)
        #expect(clock.subscriberCount == 0)
        try await waitFor { transport.draws.last?.time == 0 }
    }

    @Test func twoMissesInARowStopTheCanvasUntilRetry() async throws {
        let transport = CanvasTransport(animated: false)
        let model = try await loadedModel(transport)
        let drawer = VisualCanvasDrawer(clock: VisualDisplayClock(usesDisplayLink: false))
        drawer.configure(model: model, path: "0", canvas: canvas, reduceMotion: false)
        drawer.setVisible(true)
        transport.timeOut(1)
        drawer.resize(CGSize(width: 300, height: 100))
        // One miss draws again and recovers.
        try await waitFor { drawer.output.drawing != nil }
        #expect(drawer.output.failure == nil)
        transport.timeOut(2)
        drawer.resize(CGSize(width: 320, height: 100))
        try await waitFor { drawer.output.failure != nil }
        #expect(drawer.output.failure?.message == "the drawing took longer than 8 ms")
        let count = transport.draws.count
        drawer.resize(CGSize(width: 340, height: 100))
        try await Task.sleep(for: .milliseconds(30))
        #expect(transport.draws.count == count)
        drawer.retry()
        try await waitFor { drawer.output.failure == nil && transport.draws.last?.width == 340 }
    }

    @Test func theClockRunsOnlyWithSubscribers() {
        let clock = VisualDisplayClock(usesDisplayLink: false)
        let owner = NSObject()
        var ticks: [CFTimeInterval] = []
        clock.subscribe(owner) { ticks.append($0) }
        clock.fire(1)
        clock.unsubscribe(owner)
        clock.fire(2)
        #expect(ticks == [1])
        #expect(clock.subscriberCount == 0)
        #expect(!clock.isRunning)
    }
}
