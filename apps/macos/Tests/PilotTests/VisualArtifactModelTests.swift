import Foundation
import PilotVisualsKit
import Testing
@testable import Pilot
@testable import PilotCore

/// Answers like the visual service: every event returns a slider tree at the event's value.
private final class RecordingTransport: VisualTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [String] = []
    private var loadCount = 0
    private var active = 0
    private var peak = 0

    var events: [String] { lock.withLock { log } }
    var loads: Int { lock.withLock { loadCount } }
    var idle: Bool { lock.withLock { active == 0 } }
    var maxInFlight: Int { lock.withLock { peak } }

    func send(_ message: VisualMessage) async -> Result<Data, VisualFailure> {
        var value = 0.0
        lock.withLock {
            active += 1
            peak = max(peak, active)
            switch message {
            case .event(_, let handler, let data):
                let text = String(decoding: data, as: UTF8.self)
                log.append("\(handler)=\(text)")
                value = Double(text) ?? 0
            case .load:
                loadCount += 1
            case .probe:
                break
            }
        }
        try? await Task.sleep(for: .milliseconds(20))
        lock.withLock { active -= 1 }
        let tree: VisualValue = ["api": 1, "root": ["type": "slider", "id": "0", "min": 0, "max": 100,
                                                     "value": .number(value)]]
        return .success(VisualWire.encode(["ok": true, "tree": tree, "state": "[]"]))
    }

    func release(_ id: String) {}
}

private func visualRevision(api: Int = 1) -> ArtifactRevision {
    ArtifactRevision(id: "visual-\(UUID().uuidString)", sessionId: "s", projectId: nil, title: "Visual", kind: .visual,
                     revision: 1, createdAt: 1, updatedAt: 1, source: "({ ui }) => () => ui.text('x')", html: "",
                     libraries: [], data: .null, visual: ArtifactVisual(api: api, engine: "quickjs-ng 0.17.0"))
}

@MainActor
private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<500 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("timed out")
}

@Test(.timeLimit(.minutes(1))) @MainActor
func visualSliderDragsCoalesceToOneHandlerInFlightEndingAtTheLastPosition() async throws {
    let transport = RecordingTransport()
    let model = VisualArtifactModel(engine: VisualEngineClient(transport: transport))
    model.start(revision: visualRevision(), memoryKey: "test-\(UUID().uuidString)")
    try await waitUntil { model.tree != nil }
    for position in 1...100 { model.slide("0", to: Double(position)) }
    try await waitUntil { transport.events.last == "0=100" && transport.idle }
    // The first position runs at once, the rest wait for it and merge into the latest.
    #expect(transport.events.count < 10)
    #expect(transport.maxInFlight == 1)
    try await waitUntil {
        if case .slider(let slider) = model.tree?.root.kind { return slider.value == 100 }
        return false
    }
}

@Test(.timeLimit(.minutes(1))) @MainActor
func visualDiscreteEventsRunInOrder() async throws {
    let transport = RecordingTransport()
    let model = VisualArtifactModel(engine: VisualEngineClient(transport: transport))
    model.start(revision: visualRevision(), memoryKey: "test-\(UUID().uuidString)")
    try await waitUntil { model.tree != nil }
    for value in [1, 2, 3] { model.send("0", .number(Double(value))) }
    try await waitUntil { transport.events.count == 3 && transport.idle }
    #expect(transport.events == ["0=1", "0=2", "0=3"])
}

@Test @MainActor
func visualsFromANewerAPIAskForAnUpdateWithoutStarting() {
    let transport = RecordingTransport()
    let model = VisualArtifactModel(engine: VisualEngineClient(transport: transport))
    model.start(revision: visualRevision(api: 2), memoryKey: "test-\(UUID().uuidString)")
    #expect(model.unsupportedAPI == 2)
    #expect(transport.loads == 0)
}
