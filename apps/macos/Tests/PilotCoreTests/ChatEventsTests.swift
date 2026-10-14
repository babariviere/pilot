import Foundation
import Testing
@testable import PilotCore

private func eventJSON(_ text: String) -> JSONValue { try! JSONValue.decode(Data(text.utf8)) }

@Test func eventsInterleaveAtExecutionAndSurviveReplacementAndPrefix() {
    let entries = eventJSON(#"[{"id":1,"kind":"pi.user","model":[{"role":"user","content":"Start"}]},{"id":2,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"root","name":"codemode","arguments":{}}]}]},{"id":3,"kind":"pi.assistant","model":[{"role":"assistant","content":"Next"}]}]"#)
    let actions = eventJSON(#"{"type":"github_actions_update","actions":[{"id":"nested:0","kind":"push","branch":"feat/events","toolCallId":"root","afterEntryId":2,"at":1000,"exitCode":null},{"id":"nested:1","kind":"pr_opened","prNumber":441,"title":"Chat events","toolCallId":"root","afterEntryId":2,"at":2000,"exitCode":0}]}"#)
    var transcript = Transcript()
    transcript.apply(.object(["type": .string("snapshot"), "entries": entries]))
    transcript.apply(actions)
    #expect(transcript.entries.map(\.id) == [1, 2, -1, -2, 3])
    #expect(transcript.rows.map(\.id) == ["1-0", "2-0-0", "github-nested:0", "github-nested:1", "3-0-0"])
    transcript.apply(.object(["type": .string("snapshot"), "entries": .array([entries.array![2]]), "prefixPending": .bool(true)]))
    #expect(transcript.entries.map(\.id) == [3], "unknown anchors wait for their page, not the bottom")
    transcript.apply(.object(["type": .string("snapshot_prefix"), "entries": .array(Array(entries.array!.prefix(2)))]))
    #expect(transcript.entries.map(\.id) == [1, 2, -1, -2, 3])
    transcript.apply(actions)
    #expect(transcript.entries.count == 5)
    transcript.apply(eventJSON(#"{"type":"snapshot","entries":[]}"#))
    #expect(transcript.entries.isEmpty)
}

@Test func toolCallPositionAndCompactedHistoryDoNotLeakEventsFromOtherAttempts() {
    var transcript = Transcript()
    transcript.apply(eventJSON(#"{"type":"snapshot","entries":[{"id":20,"head":20,"kind":"pi.reset"},{"id":21,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"root","name":"bash","arguments":{}}]}]}]}"#))
    transcript.apply(eventJSON(#"{"type":"github_actions_update","actions":[{"id":"hidden","kind":"push","afterEntryId":2,"toolCallId":"other","exitCode":0},{"id":"visible","kind":"push","toolCallId":"root","branch":"feat/a","exitCode":0}]}"#))
    #expect(transcript.rows.map(\.id) == ["20", "21-0-0", "github-visible"])
    transcript.apply(eventJSON(#"{"type":"pilot.earlier_entries","before":20,"entries":[{"id":2,"kind":"pi.user","model":[{"role":"user","content":"Old"}]}],"more":false}"#))
    #expect(transcript.entries.map(\.id) == [2, -1, 20, 21, -2])
}

@Test func automaticEventsShareRowsAndKeepTheAgentTextBehindDisclosure() {
    var transcript = Transcript()
    transcript.apply(eventJSON(#"{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","origin":"mission","data":{"event":{"kind":"mission_task_done","text":"Task #3 marked done"}},"model":[{"role":"user","content":"Read the tasks and propose next steps","timestamp":1000}]},{"id":2,"kind":"pilot.activity","data":{"text":"Read the decisions tool","event":{"kind":"mission_decisions_changed","text":"Mission decisions changed"}},"model":[]},{"id":3,"kind":"pi.compaction","data":{"tokensBefore":142000,"tokensAfter":18000,"summary":"Kept summary"}},{"id":4,"kind":"pi.reset","model":[{"role":"user","content":"Reset handoff"}]},{"id":5,"kind":"pi.assistant","model":[{"role":"assistant","content":[],"stopReason":"aborted"}]},{"id":6,"kind":"pi.user","origin":"coordinator","model":[{"role":"user","content":"Please review"}]}]}"#))
    let events = transcript.rows.compactMap { row -> ChatEvent? in if case let .event(event) = row { event } else { nil } }
    #expect(events.map(\.text) == ["Task #3 marked done", "Mission decisions changed", "Context compacted · 142k to 18k tokens", "Context reset", "Stopped"])
    #expect(events.map(\.detail) == ["Read the tasks and propose next steps", "Read the decisions tool", "Kept summary", "Reset handoff", nil])
    #expect(transcript.rows.last == .automatic(id: "6-0", text: "Please review", origin: .coordinator))
}

@Test func onlyAdjacentMatchingEventsCollapseAndUnknownStatusIsQuiet() {
    var transcript = Transcript()
    transcript.apply(eventJSON(#"{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","model":[{"role":"user","content":"Start"}]},{"id":2,"kind":"pi.user","model":[{"role":"user","content":"Between"}]},{"id":3,"kind":"pilot.activity","data":{"text":"Details","event":{"kind":"mission_updated","text":"Mission updated"}}},{"id":4,"kind":"pilot.activity","data":{"text":"Details","event":{"kind":"mission_updated","text":"Mission updated"}}}]}"#))
    transcript.apply(eventJSON(#"{"type":"github_actions_update","actions":[{"id":"a","kind":"push","branch":"feat/a","afterEntryId":1,"at":1,"exitCode":null},{"id":"b","kind":"push","branch":"feat/a","afterEntryId":1,"at":2,"exitCode":0},{"id":"c","kind":"push","branch":"feat/a","afterEntryId":2,"exitCode":0},{"id":"d","kind":"push","branch":"feat/b","afterEntryId":2,"exitCode":1}]}"#))
    let events = transcript.rows.compactMap { row -> ChatEvent? in if case let .event(event) = row { event } else { nil } }
    #expect(events.map(\.count) == [2, 1, 1, 2])
    #expect(events[0].sentence == "Agent pushed 2 times to")
    #expect(events[0].endTimestamp == 2)
    #expect(!events[0].destructive && events[0].uncertainty != nil)
    #expect(events[2].destructive)
}

@Test func largeEventProjectionKeepsStreamingWorkIndependentOfHistory() async throws {
    let entries = (1...10000).map { id in JSONValue.object([
        "id": .number(Double(id)), "kind": .string("pi.user"),
        "model": .array([.object(["role": .string("user"), "content": .string(String(repeating: "History ", count: 64))])]),
    ]) }
    let actions = (0..<200).map { id in JSONValue.object([
        "id": .string("call:\(id)"), "kind": .string("push"), "branch": .string("feat/events"),
        "afterEntryId": .number(Double(id * 50 + 1)), "at": .number(Double(id)), "exitCode": .null,
    ]) }
    let processor = TranscriptProcessor()
    let snapshot = try await processor.apply([
        .object(["type": .string("snapshot"), "entries": .array(entries)]),
        .object(["type": .string("github_actions_update"), "actions": .array(actions)]),
    ])
    #expect(snapshot.rows.count == 10200)
    let copies = await processor.historyRowCopyCount
    _ = try await processor.apply([eventJSON(#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":""}]}}"#)])
    for _ in 0..<1000 {
        _ = try await processor.apply([eventJSON(#"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":"a"}]}"#)])
    }
    #expect(await processor.committedRowBuildCount == 1)
    #expect(await processor.historyRowCopyCount == copies)
}
