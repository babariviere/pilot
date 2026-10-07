import Foundation
import Testing
@testable import PilotCore

private func event(_ text: String) -> JSONValue { try! JSONValue.decode(Data(text.utf8)) }

@Test func largeToolGroupsPreserveOrderAndStableIdentity() {
    let count = 3000
    let entries: [JSONValue] = (0..<count).map { index in
        .object([
            "id": .number(Double(index + 1)), "kind": .string("pi.assistant"),
            "model": .array([.object([
                "role": .string("assistant"), "content": .array([.object([
                    "type": .string("toolCall"), "id": .string("call-\(index)"), "name": .string("bash"),
                    "arguments": .object(["command": .string("echo \(index)")]),
                ])]),
            ])]),
        ])
    }
    var transcript = Transcript()
    transcript.apply(.object(["type": .string("snapshot"), "entries": .array(entries)]))
    let rows = transcript.rows
    #expect(rows.count == 1)
    guard case let .tools(id, items)? = rows.first else { Issue.record("expected tool group"); return }
    #expect(id == "1-0-0")
    #expect(items.map(\.id) == (0..<count).map { "call-\($0)" })
    transcript.apply(event(#"{"type":"entry_appended","entry":{"id":3001,"kind":"pi.user","model":[{"role":"user","content":"next"}]}}"#))
    #expect(transcript.rows.count == 2)
    #expect(transcript.rows[0].id == id)
    #expect(transcript.rows[1] == .user(id: "3001-0", text: "next"))
}

@Test func backgroundPresentationAppliesSnapshotsDeltasAndReplacements() async throws {
    let processor = TranscriptProcessor()
    let first = try await processor.apply([
        event(#"{"type":"snapshot","entries":[],"tools":[],"inbox":[],"run":{}}"#),
        event(#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}"#),
    ])
    #expect(first.working && first.streaming)
    #expect(first.rows == [.text(id: "streaming-0", text: "Hello")])
    let second = try await processor.apply([
        event(#"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":" world"}]}"#),
        event(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"Run tests"}]}"#),
    ])
    #expect(second.rows == [.text(id: "streaming-0", text: "Hello world")])
    #expect(second.queued == 1)
    #expect(second.revision > first.revision)
    let replaced = try await processor.apply([
        event(#"{"type":"snapshot","entries":[],"tools":[],"inbox":[]}"#),
        event(#"{"type":"queue_update","items":[]}"#),
    ])
    #expect(replaced.rows.isEmpty && !replaced.working && !replaced.streaming)
    #expect(replaced.queued == 0 && replaced.revision > second.revision)
    let ignored = try await processor.apply([event(#"{"type":"usage_update"}"#)])
    #expect(ignored == replaced)
}

@Test func backgroundPresentationPublishesQueueEditsEvenWhenCountIsUnchanged() async throws {
    let processor = TranscriptProcessor()
    let original = event(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"Original"},{"id":11,"mode":"steer","content":"Steering"}]}"#)
    let first = try await processor.apply([original])
    #expect(first.queuedMessages.map(\.id) == [10, 11])
    #expect(first.queuedMessages.map(\.text) == ["Original", "Steering"])
    let edit = event(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"Edited"},{"id":11,"mode":"steer","content":"Steering"}]}"#)
    let edited = try await processor.apply([edit])
    #expect(edited.queued == first.queued)
    #expect(edited.queuedMessages.map(\.text) == ["Edited", "Steering"])
    #expect(edited.revision > first.revision)
    #expect(try await processor.apply([edit]) == edited)
    let snapshot = try await processor.apply([event(#"{"type":"snapshot","entries":[],"tools":[],"inbox":[]}"#)])
    #expect(snapshot.queuedMessages == edited.queuedMessages)
    let cleared = try await processor.apply([event(#"{"type":"queue_update","items":[]}"#)])
    #expect(cleared.queuedMessages.isEmpty && cleared.revision > edited.revision)
}

@Test func cachedToolSummariesFollowArgumentAndOutputChanges() async throws {
    let processor = TranscriptProcessor()
    let start = event(#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"bash","arguments":{"command":"ls"}}]}}"#)
    let first = try await processor.apply([start])
    guard case let .tools(_, firstItems)? = first.rows.first else { Issue.record("expected tools"); return }
    #expect(firstItems[0].summary.detail == "ls")
    let second = try await processor.apply([
        event(#"{"type":"tool_execution_start","toolCallId":"c","toolName":"bash"}"#),
        event(#"{"type":"tool_execution_update","toolCallId":"c","output":{"append":"out"}}"#),
        event(#"{"type":"message_update","changes":[{"type":"block","contentIndex":0,"block":{"type":"toolCall","id":"c","name":"bash","arguments":{"command":"pwd"}}}]}"#),
    ])
    guard case let .tools(_, secondItems)? = second.rows.first else { Issue.record("expected tools"); return }
    #expect(secondItems[0].summary.detail == "pwd")
    #expect(secondItems[0].output == "out" && secondItems[0].status == .running)
    #expect(firstItems[0].summary.detail == "ls")
}

@Test func decodesWebSocketEventsWithoutLosingSnapshotOrDeltaOrder() throws {
    let data = Data(#"{"type":"events","sessionId":"s","events":[{"type":"snapshot","entries":[]},{"type":"run_start"}]}"#.utf8)
    guard case let .events(id, events)? = try ServerUpdate.decode(data) else { Issue.record("expected events"); return }
    #expect(id == "s")
    #expect(events.map { $0["type"]?.string } == ["snapshot", "run_start"])
    #expect(try ServerUpdate.decode(Data(#"{"type":"future"}"#.utf8)) == nil)
}

@Test func decodesSessionAndTerminalUpdates() throws {
    let data = Data(#"{"type":"sessions","sessions":[{"id":"a","title":"A","cwd":"/tmp","createdAt":1,"updatedAt":1,"state":"parked"},{"id":"b","title":"B","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"starting"}]}"#.utf8)
    guard case let .sessions(list)? = try ServerUpdate.decode(data) else { Issue.record("expected sessions"); return }
    #expect(list.map(\.id) == ["b", "a"])
    guard case let .terminalData(id, output)? = try ServerUpdate.decode(Data(#"{"type":"terminal.data","sessionId":"s","data":"hi"}"#.utf8)) else {
        Issue.record("expected terminal data"); return
    }
    #expect(id == "s" && output == "hi")
}

@Test func cancelledPresentationDoesNotReduceQueuedEvents() async throws {
    let processor = TranscriptProcessor()
    let task = Task {
        withUnsafeCurrentTask { $0?.cancel() }
        _ = try await processor.apply([event(#"{"type":"run_start"}"#)])
    }
    do {
        try await task.value
        Issue.record("cancelled processing should throw")
    } catch {
        #expect(error is CancellationError)
    }
    let result = try await processor.apply([])
    #expect(!result.working && result.rows.isEmpty)
}

@Test func backgroundSessionDecodingPreservesUsageFooterData() throws {
    let data = Data(#"{"type":"session","session":{"id":"s","title":"Usage","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"working","usage":{"context":{"tokens":100,"contextWindow":200000,"percent":0.05},"subscription":{"fetchedAt":1,"provider":"anthropic","windows":[{"label":"5h","usedPercent":25}]}}}}"#.utf8)
    guard case let .session(session)? = try ServerUpdate.decode(data) else { Issue.record("expected session"); return }
    #expect(session.usage?.context?.tokens == 100)
    #expect(session.usage?.subscription?.windows.first?.usedPercent == 25)
}
