import Foundation
import Testing
@testable import PilotCore

private func corePerformanceEvent(_ source: String) throws -> JSONValue {
    try JSONValue.decode(Data(source.utf8))
}

private func corePerformanceEntry(_ id: Int, role: String = "user", content: JSONValue? = nil) -> JSONValue {
    .object([
        "id": .number(Double(id)), "kind": .string("pi.\(role)"),
        "model": .array([.object([
            "role": .string(role), "content": content ?? .string("entry \(id)"),
        ])]),
    ])
}

@Test func corePerformanceLongFencesPreserveLinesAtIncreasingSizes() {
    // Increasing workloads exercise the append path without machine-dependent time limits.
    for count in [256, 4096, 16384] {
        let body = (0..<count).map { "  line \($0)\t" }.joined(separator: "\n")
        #expect(Markdown.parse("````swift\n\(body)\n```\n````") == [
            .code(language: "swift", text: body + "\n```"),
        ])
        #expect(Markdown.parse("```mermaid\n\(body)") == [.code(language: "mermaid", text: body)])
        #expect(Markdown.parse("```svg\n\(body)\n```\n```\nnext\n```") == [
            .diagram(kind: .svg, text: body), .code(language: nil, text: "next"),
        ])
    }
}

@Test func corePerformanceJSONPreservesScalarTypesAndRejectsCoercions() throws {
    let value = try corePerformanceEvent(#"[null,true,false,0,1,-1,1.5,1e3,"1",{"nested":[false,1,null]}]"#)
    #expect(value == .array([
        .null, .bool(true), .bool(false), .number(0), .number(1), .number(-1),
        .number(1.5), .number(1000), .string("1"),
        .object(["nested": .array([.bool(false), .number(1), .null])]),
    ]))
    for scalar in [JSONValue.null, .bool(true), .bool(false), .number(0), .number(1), .string("s")] {
        #expect(try JSONValue.decode(JSONEncoder().encode(scalar)) == scalar)
        #expect(try scalar.decode(JSONValue.self) == scalar)
    }
    #expect(throws: (any Error).self) { try JSONValue.number(1).decode(Bool.self) }
    #expect(throws: (any Error).self) { try JSONValue.bool(true).decode(Int.self) }
    #expect(throws: (any Error).self) { try JSONValue.number(1.5).decode(Int.self) }
    #expect(throws: (any Error).self) { try JSONValue.number(256).decode(UInt8.self) }
    #expect(throws: (any Error).self) { try JSONValue.number(-1).decode(UInt.self) }
    #expect(throws: (any Error).self) { try JSONValue.null.decode(String.self) }
    #expect(throws: (any Error).self) { try corePerformanceEvent("1e400") }
    #expect(JSONValue.number(.infinity).int == nil)
    #expect(JSONValue.number(Double(Int.max)).int == nil)
    #expect(JSONValue.number(1.9).int == 1)
}

@Test func corePerformanceTypedJSONDecodeMatchesDefaultFoundationStrategies() throws {
    struct Payload: Codable, Equatable {
        let flag: Bool
        let count: Int
        let ratio: Float
        let optional: String?
        let values: [JSONValue]
        let date: Date
        let data: Data
        let url: URL
        let decimal: Decimal
    }
    let source = #"{"flag":true,"count":42,"ratio":1.25,"optional":null,"values":[null,false,1],"date":1234,"data":"aGk=","url":"https://example.com/a","decimal":1.25}"#
    let bytes = Data(source.utf8)
    let expected = try JSONDecoder().decode(Payload.self, from: bytes)
    #expect(try JSONValue.decode(bytes).decode(Payload.self) == expected)
    #expect(try JSONValue.array([.number(1), .null, .number(3)]).decode([Int?].self) == [1, nil, 3])
    #expect(throws: (any Error).self) { try JSONValue.object([:]).decode(Payload.self) }
    do {
        _ = try JSONValue.object(["items": .array([.number(1), .bool(true)])]).decode([String: [Int]].self)
        Issue.record("Expected a type mismatch")
    } catch DecodingError.typeMismatch(_, let context) {
        #expect(context.codingPath.map(\.stringValue) == ["items", "Index 1"])
    }
}

@Test func corePerformanceJSONDecodeScalesAcrossNestedCollections() throws {
    for count in [64, 1024, 8192] {
        let item = #"{"bool":true,"zero":0,"one":1,"null":null,"list":[false,1,"text"]}"#
        let bytes = Data(("[" + Array(repeating: item, count: count).joined(separator: ",") + "]").utf8)
        let value = try JSONValue.decode(bytes)
        let typed = try value.decode([[String: JSONValue]].self)
        #expect(typed.count == count)
        #expect(typed.allSatisfy {
            $0["bool"] == .bool(true) && $0["zero"] == .number(0) && $0["one"] == .number(1)
                && $0["null"] == .null && $0["list"] == .array([.bool(false), .number(1), .string("text")])
        })
    }
}

@Test func corePerformanceCachedRowsMatchReducerAcrossBatchesAndReplacements() async throws {
    let processor = TranscriptProcessor()
    var transcript = Transcript()
    let batches: [[String]] = [
        [#"{"type":"snapshot","entries":[{"id":5,"kind":"pi.user","model":[{"role":"user","content":"hi"}]}]}"#],
        [#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"bash","arguments":{"command":"ls"}}]}}"#,
         #"{"type":"tool_execution_start","toolCallId":"a","toolName":"bash"}"#],
        [#"{"type":"message_end","entry":{"id":6,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"bash","arguments":{"command":"ls"}}]}]}}"#,
         #"{"type":"tool_execution_end","toolCallId":"a","entry":{"id":7,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"a","content":"done"}]}}"#],
        [#"{"type":"entry_appended","entry":{"id":1,"kind":"pi.reset"}}"#,
         #"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}"#],
        [#"{"type":"run_end"}"#, #"{"type":"task_failed","message":"failed"}"#],
        [#"{"type":"snapshot","entries":[]}"#,
         #"{"type":"entry_appended","entry":{"id":6,"kind":"pi.user","model":[{"role":"user","content":"reused ID"}]}}"#],
    ]
    for batch in batches {
        let events = try batch.map(corePerformanceEvent)
        transcript.apply(events)
        var actual = try await processor.apply(events)
        actual.revision = 0
        #expect(actual == TranscriptPresentation(transcript: transcript))
    }
}

@Test func corePerformanceEntryDedupIndexSurvivesReplacementAndValueCopies() throws {
    var transcript = Transcript()
    let entries = (1...4096).map { corePerformanceEntry($0) }
    transcript.apply(.object(["type": .string("snapshot"), "entries": .array(entries.reversed())]))
    let original = transcript
    let revision = transcript.rowRevision
    transcript.apply(entries.map { .object(["type": .string("entry_appended"), "entry": $0]) })
    #expect(transcript == original)
    #expect(transcript.rowRevision == revision)
    transcript.apply(.object(["type": .string("entry_appended"), "entry": corePerformanceEntry(0)]))
    #expect(transcript.entries.map(\.id) == Array(0...4096))
    #expect(original.entries.count == 4096)
    transcript.entries = [] // Public replacement must also refresh the ID lookup.
    transcript.apply(.object(["type": .string("entry_appended"), "entry": corePerformanceEntry(1)]))
    #expect(transcript.entries.map(\.id) == [1])
    transcript.apply(try corePerformanceEvent(#"{"type":"snapshot","entries":[]}"#))
    transcript.apply(.object(["type": .string("entry_appended"), "entry": corePerformanceEntry(1)]))
    #expect(transcript.entries.map(\.id) == [1])
}

@Test func corePerformanceProcessorReusesHistoryForNoOpsMetadataAndStreaming() async throws {
    for count in [32, 2048] {
        let processor = TranscriptProcessor()
        let entries = (1...count).map { corePerformanceEntry($0) }
        let first = try await processor.apply([.object(["type": .string("snapshot"), "entries": .array(entries)])])
        #expect(await processor.rowBuildCount == 1)
        #expect(await processor.committedRowBuildCount == 1)
        let ignored = try await processor.apply([
            .object(["type": .string("future")]),
            .object(["type": .string("entry_appended"), "entry": entries[0]]),
        ])
        #expect(ignored == first)
        let metadata = try await processor.apply([try corePerformanceEvent(#"{"type":"run_start"}"#)])
        #expect(metadata.working && metadata.rows == first.rows)
        #expect(await processor.rowBuildCount == 1)
        _ = try await processor.apply([try corePerformanceEvent(#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":""}]}}"#)])
        for _ in 0..<64 {
            _ = try await processor.apply([try corePerformanceEvent(#"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":"x"}]}"#)])
        }
        #expect(await processor.committedRowBuildCount == 1)
        let streamed = try await processor.apply([])
        #expect(streamed.rows.last == .text(id: "streaming-0", text: String(repeating: "x", count: 64)))
        #expect(first.rows.count == count) // Returned presentations remain immutable snapshots.
        let builds = await processor.rowBuildCount
        #expect(try await processor.apply([try corePerformanceEvent(#"{"type":"usage_update"}"#)]) == streamed)
        #expect(await processor.rowBuildCount == builds)
        let replacement = try await processor.apply([try corePerformanceEvent(#"{"type":"snapshot","entries":[]}"#)])
        #expect(replacement.rows.isEmpty && !replacement.streaming)
        #expect(await processor.committedRowBuildCount == 2)
    }
}

@Test func corePerformanceStreamingToolGroupKeepsCommittedIdentity() async throws {
    let processor = TranscriptProcessor()
    let tool: JSONValue = .array([.object([
        "type": .string("toolCall"), "id": .string("a"), "name": .string("bash"),
        "arguments": .object(["command": .string("ls")]),
    ])])
    let first = try await processor.apply([.object([
        "type": .string("snapshot"), "entries": .array([corePerformanceEntry(1, role: "assistant", content: tool)]),
    ])])
    let second = try await processor.apply([try corePerformanceEvent(#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"toolCall","id":"b","name":"bash","arguments":{"command":"pwd"}}]}}"#)])
    guard case let .tools(id, items)? = second.rows.first else { Issue.record("Expected a tool group"); return }
    #expect(id == first.rows.first?.id)
    #expect(items.map(\.id) == ["a", "b"])
    #expect(items.map { $0.summary.detail } == ["ls", "pwd"])
    #expect(await processor.committedRowBuildCount == 1)
    let updated = try await processor.apply([
        try corePerformanceEvent(#"{"type":"tool_execution_start","toolCallId":"a","toolName":"bash"}"#),
        try corePerformanceEvent(#"{"type":"tool_execution_update","toolCallId":"a","output":{"append":"out"}}"#),
    ])
    guard case let .tools(_, updatedItems)? = updated.rows.first else { Issue.record("Expected tools"); return }
    #expect(updatedItems[0].output == "out" && updatedItems[0].status == .running)
    #expect(items[0].output.isEmpty && items[0].status == .pending)
}
