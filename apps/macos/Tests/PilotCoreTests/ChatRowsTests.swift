import Foundation
import Testing
@testable import PilotCore

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
    guard case let .tools(_, items) = rows[0] else { Issue.record("expected tools"); return }
    #expect(items.map(\.id) == ["a", "b"])
    #expect(items[0].status == .done)
    #expect(rows[1] == .text(id: "3-0-2", text: "Done."))
}
