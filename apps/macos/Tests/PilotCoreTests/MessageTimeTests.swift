import Foundation
import Testing
@testable import PilotCore

private func timeEvent(_ source: String) throws -> JSONValue {
    try JSONValue.decode(Data(source.utf8))
}

@Test func messageTimesDecodeOnlyValidEpochMilliseconds() {
    let valid: Double = 1_781_015_528_123
    #expect(ChatMessage(json: .object(["timestamp": .number(valid)])).timestamp == valid)
    #expect(MessageTimeFormatting.date(valid)?.timeIntervalSince1970 == valid / 1_000)
    #expect(ChatMessage(json: .object([:])).timestamp == nil)
    for value in [JSONValue.null, .string("1781015528123"), .bool(true), .number(-1),
                  .number(.nan), .number(.infinity), .number(1e30)] {
        #expect(ChatMessage(json: .object(["timestamp": value])).timestamp == nil)
    }
    #expect(MessageTimeFormatting.label(-1) == nil)
    #expect(MessageTimeFormatting.detail(.infinity) == nil)
}

@Test func messageTimeFormattingUsesLocaleAndTimezone() throws {
    // June 9, 2026, 14:32:08 UTC. These are not relative dates.
    let milliseconds = try #require(ISO8601DateFormatter().date(from: "2026-06-09T14:32:08Z")).timeIntervalSince1970 * 1_000
    let utc = try #require(TimeZone(secondsFromGMT: 0))
    let paris = try #require(TimeZone(identifier: "Europe/Paris"))
    let english = Locale(identifier: "en_US")
    let french = Locale(identifier: "fr_FR")
    let label = try #require(MessageTimeFormatting.label(milliseconds, locale: english, timeZone: utc))
    #expect(label.contains("2026") && label.contains("2:32"))
    let local = try #require(MessageTimeFormatting.label(milliseconds, locale: french, timeZone: paris))
    #expect(local.contains("2026") && local.contains("16:32"))
    let detail = try #require(MessageTimeFormatting.detail(milliseconds, locale: english, timeZone: utc))
    #expect(detail.contains("June") && detail.contains("2:32:08") && detail.contains("GMT"))
}

@Test func originalMessageTimesSurviveSnapshotStreamingAndCommit() async throws {
    let processor = TranscriptProcessor()
    let first = try await processor.apply([
        timeEvent(#"{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","model":[{"role":"user","timestamp":1781015528123,"content":"Hello"}]}],"generation":{"message":{"role":"assistant","timestamp":1781015588123,"content":[{"type":"thinking","thinking":"Plan"},{"type":"text","text":"Hi"}]}}}"#),
    ])
    #expect(first.rows == [
        .user(id: "1-0", text: "Hello", timestamp: 1_781_015_528_123),
        .thinking(id: "streaming-0", text: "Plan", streaming: false),
        .text(id: "streaming-1", text: "Hi", timestamp: 1_781_015_588_123),
    ])
    let delta = try await processor.apply([
        timeEvent(#"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":1,"delta":" there"}]}"#),
    ])
    #expect(delta.rows.last == .text(id: "streaming-1", text: "Hi there", timestamp: 1_781_015_588_123))
    #expect(delta.historyRevision == first.historyRevision)
    let entry = #"{"id":2,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":1781015588123,"content":[{"type":"text","text":"Hi there"},{"type":"text","text":"More"}]}]}"#
    let committed = try await processor.apply([timeEvent(#"{"type":"message_end","entry":\#(entry)}"#)])
    #expect(committed.rows.suffix(2) == [
        .text(id: "2-0-0", text: "Hi there", timestamp: 1_781_015_588_123),
        .text(id: "2-0-1", text: "More", timestamp: 1_781_015_588_123),
    ])
    let recovered = try await TranscriptProcessor().apply([timeEvent(#"{"type":"snapshot","entries":[\#(entry)]}"#)])
    #expect(recovered.rows == Array(committed.rows.suffix(2)))
}

@Test func timestampOnlyReplacementInvalidatesPreparedHistory() async throws {
    let processor = TranscriptProcessor()
    func snapshot(_ timestamp: Double) -> JSONValue {
        .object(["type": .string("snapshot"), "entries": .array([.object([
            "id": .number(1), "kind": .string("pi.user"), "model": .array([.object([
                "role": .string("user"), "content": .string("Same"), "timestamp": .number(timestamp),
            ])]),
        ])])])
    }
    let first = try await processor.apply([snapshot(1_000)])
    let second = try await processor.apply([snapshot(2_000)])
    #expect(second.revision > first.revision)
    #expect(second.historyRevision != first.historyRevision)
    #expect(second.rows == [.user(id: "1-0", text: "Same", timestamp: 2_000)])
}
