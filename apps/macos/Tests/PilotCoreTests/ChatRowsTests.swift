import Foundation
import Testing
@testable import PilotCore

@Test func daemonActivityUsesExistingNoticeRow() throws {
    var transcript = Transcript()
    let snapshot = #"{"type":"snapshot","entries":[{"id":1,"kind":"pilot.activity","data":{"text":"Rebased PR #1 onto main"},"model":[]}],"tools":[],"inbox":[]}"#
    transcript.apply(try JSONValue.decode(Data(snapshot.utf8)))
    #expect(transcript.rows == [.event(ChatEvent(id: "1", kind: "activity", text: "Rebased PR #1 onto main"))])
}

@Test func parsesMarkdownBlocks() {
    let blocks = Markdown.parse("""
    ## Root cause

    The lease is **held**.

    1. First
    2. Second

    ```ts
    let x = 1
    ```
    - a
    - b
    > quoted
    """)
    #expect(blocks == [
        .heading(level: 2, text: "Root cause"),
        .paragraph("The lease is **held**."),
        .list(ordered: true, start: 1, items: ["First", "Second"]),
        .code(language: "ts", text: "let x = 1"),
        .list(ordered: false, start: 1, items: ["a", "b"]),
        .quote("quoted"),
    ])
}

@Test func unterminatedFenceIsCode() {
    #expect(Markdown.parse("```\nstreaming") == [.code(language: nil, text: "streaming")])
}

@Test func summarizesCodemodeBashCalls() {
    let code = JSONValue.object(["code": .string(#"text(await tools.bash({command:"npm test -- kernel"}));"#)])
    let summary = ToolSummary(name: "codemode", arguments: code)
    #expect(summary.title == "Ran command")
    #expect(summary.detail == "npm test -- kernel")
    let patch = JSONValue.object(["patch": .string("*** Begin Patch\n*** Update File: a/b/session.ts\n*** End Patch")])
    #expect(ToolSummary(name: "applyPatch", arguments: patch).detail == "session.ts")
}

@Test func groupsConsecutiveToolCallsAcrossMessages() throws {
    var transcript = Transcript()
    let snapshot = #"{"type":"snapshot","entries":[{"id":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"read","arguments":{"path":"x"}}]}]},{"id":2,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"a","content":[{"type":"text","text":"ok"}],"isError":false}]},{"id":3,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"toolCall","id":"b","name":"bash","arguments":{"command":"ls"}},{"type":"text","text":"Done."}]}]}],"tools":[],"inbox":[]}"#
    transcript.apply(try JSONValue.decode(Data(snapshot.utf8)))
    let rows = transcript.rows
    #expect(rows.count == 2)
    guard case let .tools(_, items) = rows[0].unfolded.first else { Issue.record("expected tools"); return }
    #expect(items.map(\.id) == ["a", "b"])
    #expect(items[0].status == .done)
    #expect(rows[1] == .text(id: "3-0-2", text: "Done."))
}


@Test func foldsATurnsWorkBetweenTheMessageAndTheAnswer() throws {
    var transcript = Transcript()
    let snapshot = #"{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","model":[{"role":"user","content":"Fix it","timestamp":1000}]},{"id":2,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":2000,"content":[{"type":"thinking","thinking":"Plan"},{"type":"text","text":"Reading first."},{"type":"toolCall","id":"a","name":"read","arguments":{"path":"src/a.ts"}},{"type":"toolCall","id":"b","name":"read","arguments":{"path":"src/b.ts"}}]}]},{"id":3,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"a","content":"x","timestamp":3000},{"role":"toolResult","toolCallId":"b","content":"y","timestamp":4000}]},{"id":4,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":5000,"content":[{"type":"toolCall","id":"c","name":"bash","arguments":{"command":"pnpm test"}}]}]},{"id":5,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c","content":"fail","isError":true,"timestamp":190000}]},{"id":6,"kind":"pi.assistant","model":[{"role":"assistant","timestamp":200000,"content":[{"type":"text","text":"Fixed."}]}]}],"tools":[],"inbox":[]}"#
    transcript.apply(try JSONValue.decode(Data(snapshot.utf8)))
    let rows = transcript.rows
    #expect(rows.map(\.id) == ["1-0", "2-0-0", "6-0-0"])
    guard case let .work(_, group) = rows[1] else { Issue.record("expected a work row"); return }
    #expect(group.steps.map(\.id) == ["2-0-0", "2-0-1", "a", "c"])
    #expect(group.steps[2].sentence.verb == "Read" && group.steps[2].sentence.subject == "a.ts, b.ts")
    #expect(group.steps[3].sentence.verb == "Ran" && group.steps[3].sentence.subject == "pnpm test")
    #expect(group.summary(active: false).lead == "Worked for 3 min")
    #expect(group.summary(active: false).detail == "read 2 files, ran 1 command")
    #expect(group.summary(active: true).lead == "Working")
    #expect(group.failureCount == 1 && group.endedOnFailure)
    #expect(rows[2] == .text(id: "6-0-0", text: "Fixed.", timestamp: 200000))
}

@Test func workCountsAndDurationsReadAsSentences() {
    #expect(TurnWork.duration(400) == nil)
    #expect(TurnWork.duration(12000) == "12s")
    #expect(TurnWork.duration(3_900_000) == "1 h 5 min")
    #expect(TurnWork.duration(7_200_000) == "2 h")
    func tool(_ id: String, _ name: String, _ arguments: JSONValue) -> ToolItem {
        ToolItem(id: id, name: name, arguments: arguments, status: .done, output: "")
    }
    let edit = tool("e", "edit", .object(["path": .string("a/x.swift"), "oldText": .string("a"), "newText": .string("b")]))
    #expect(TurnWork.counts([edit]) == "edited 1 file")
    #expect(TurnWork.counts([tool("r", "read", .object(["path": .string("x")])), edit,
                              tool("s", "web_search", .object(["query": .string("q")])),
                              tool("m", "mcp__linear__list_issues", .object([:]))])
        == "read 1 file, edited 1, searched the web, used 1 tool")
    #expect(tool("m", "mcp__linear__list_issues", .object([:])).summary.verb == "Used linear list issues")
    #expect(edit.summary.subject == "x.swift")
    let thought = TurnWork(rows: [.thinking(id: "t", text: "Hmm", streaming: false)], startedAt: 0, endedAt: 5000)
    #expect(thought.summary(active: false).lead == "Thought for 5s" && thought.summary(active: false).detail == nil)
}

@Test func streamedStepsContinueTheCommittedWorkRow() async throws {
    let processor = TranscriptProcessor()
    let snapshot = #"{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","model":[{"role":"user","content":"Go"}]},{"id":2,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Checking."},{"type":"toolCall","id":"a","name":"bash","arguments":{"command":"ls"}}]}]}],"tools":[],"inbox":[]}"#
    let first = try await processor.apply([try JSONValue.decode(Data(snapshot.utf8))])
    #expect(first.historyRowCount == 1 && first.liveRows.map(\.id) == ["2-0-0"])
    let start = #"{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Next"},{"type":"toolCall","id":"b","name":"bash","arguments":{"command":"pwd"}}]}}"#
    let streamed = try await processor.apply([try JSONValue.decode(Data(start.utf8))])
    #expect(streamed.historyRevision == first.historyRevision)
    #expect(streamed.liveRows.count == 1)
    guard case let .work(id, group) = streamed.liveRows[0] else { Issue.record("expected a work row"); return }
    #expect(id == "2-0-0")
    #expect(group.steps.map(\.id) == ["2-0-0", "a", "streaming-0", "b"])
    #expect(streamed.cachedByteCount == TranscriptPresentation.byteCount(of: streamed.rows))
    // A streamed answer stays outside the work row.
    let answer = #"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}"#
    let answered = try await processor.apply([try JSONValue.decode(Data(answer.utf8))])
    #expect(answered.liveRows.map(\.id) == ["2-0-0", "streaming-0"])
}
