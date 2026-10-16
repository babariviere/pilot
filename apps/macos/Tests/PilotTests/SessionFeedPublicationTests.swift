import Combine
import Foundation
import PilotCore
import Testing
@testable import Pilot

private func feedEvent(_ json: String) throws -> JSONValue {
    try JSONValue.decode(Data(json.utf8))
}

private func waitUntil(_ check: @MainActor () -> Bool) async {
    for _ in 0 ..< 300 where !(await check()) { try? await Task.sleep(for: .milliseconds(10)) }
}

@MainActor private final class Counter {
    var value = 0
}

@Test @MainActor func streamedTextPublishesRowsWithoutRepublishingTheChatAroundThem() async throws {
    let feed = SessionFeed(sessionId: "s", transcript: Transcript())
    feed.applyFixtureEvents([
        try feedEvent(#"{"type":"snapshot","entries":[],"run":{}}"#),
        // Start with text, so the transcript already has rows: their first appearance is a real status change.
        try feedEvent(#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"Hi "}]}}"#),
    ])
    await waitUntil { feed.status.streaming && feed.status.hasRows }
    #expect(feed.status.working)
    let statusChanges = Counter()
    let rowChanges = Counter()
    let observations = [
        feed.objectWillChange.sink { statusChanges.value += 1 },
        feed.rows.objectWillChange.sink { rowChanges.value += 1 },
    ]
    for _ in 0 ..< 20 {
        feed.applyFixtureEvents([try feedEvent(
            #"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":"x"}]}"#)])
        try await Task.sleep(for: .milliseconds(3))
    }
    let expected = ChatRow.text(id: "streaming-0", text: "Hi " + String(repeating: "x", count: 20), timestamp: nil)
    await waitUntil { feed.presentation.liveRows.last == expected }
    #expect(feed.presentation.liveRows.last == expected)
    #expect(rowChanges.value > 0)
    // Composer, working line and banners read the status, which streamed text does not change.
    #expect(statusChanges.value == 0)
    withExtendedLifetime(observations) {}
}

@Test @MainActor func framePacerMergesRequestsWithinOneFrame() async throws {
    let runs = Counter()
    let pacer = DisplayFramePacer { runs.value += 1 }
    pacer.request()
    #expect(runs.value == 1, "the first request after a quiet frame runs at once")
    for _ in 0 ..< 10 { pacer.request() }
    #expect(runs.value == 1)
    await waitUntil { runs.value == 2 }
    try await Task.sleep(for: .milliseconds(60))
    #expect(runs.value == 2, "requests within one frame run once, on the next frame")
    pacer.request()
    #expect(runs.value == 3)
    pacer.request()
    pacer.cancel()
    try await Task.sleep(for: .milliseconds(60))
    #expect(runs.value == 3, "a cancelled request never runs")
}
