import Testing
@testable import PilotCore

private let streamedDocuments = [
    // Fences with blank lines inside, a diagram, an unterminated fence at the end and CRLF lines.
    "# Title\n\nSome *para*\ncontinued\n\n```swift\nlet x = 1\n\nlet y = 2\n```\nAfter code\n````mermaid\ngraph TD\n```\n\nA-->B\n````\n"
        + "para\r\n\r\nnext\n```\nunterminated\n\ncode",
    // Lists: continuations, switching between ordered and unordered, and a paragraph ending one.
    "- a\n- b\n  continued item\n\tmore\n1. one\n2) two\n* star\n+ plus\nplain after list\n\n10. ten\n   continued",
    // Tables, quotes, headings and rules directly after other blocks.
    "| a | b |\n|---|:-:|\n| 1 | 2 |\n> quote\n> more\ntext\n---\n## H2\n| x |\n***\n___\n#nospace\n> q\n\n| last |",
    // Fence-like lines that do not open or close fences.
    "``` inline ` tick\n``notfence\n````js\n```\n```` extra\n````\nafter",
    // Tables: a header taken from the end of a paragraph, alignments, escaped and code-span pipes, ragged rows,
    // tables ended by a quote, a list item, a paragraph line and a fence, and pipe lines that are not tables.
    "Intro line\n| Name | Note |\n| :--- | ---: |\n| `a|b` | x \\| y |\n| short |\n| 1 | 2 | 3 |\n> after\n\n"
        + "a | b\n--|--\n1 | 2\n- item\n\n| x |\n|---|\n| y |\nplain\n| p | q |\n|---|\n\n"
        + "| h |\n| - |\n```\n| in | code |\n|---|---|\n```\n| é | 🙂 |\r\n|:-:|-|\r\n| ü | 漢 |\r\n",
    // A table still being written: the last row has no newline yet.
    "| Step | Result |\n|---|---|\n| one | **ok** |\n| two | [link](https://example.com) |\n| three | pend",
]

private func prefixes(of text: String, chunk: Int) -> [String] {
    let characters = Array(text)
    return stride(from: chunk, through: characters.count + chunk - 1, by: chunk).map {
        String(characters[0 ..< min($0, characters.count)])
    }
}

@Test func markdownStreamMatchesAFullParseAfterEveryUpdate() {
    for document in streamedDocuments {
        for chunk in [1, 2, 5, 13] {
            var stream = MarkdownStream()
            var stableCount = 0
            for prefix in prefixes(of: document, chunk: chunk) {
                stream.update(prefix)
                let expected = Markdown.parse(prefix)
                #expect(stream.blocks == expected, "chunk \(chunk): \(prefix.debugDescription)")
                // Final blocks are never revised, only extended.
                #expect(stream.stableBlocks.count >= stableCount)
                stableCount = stream.stableBlocks.count
            }
        }
    }
}

@Test func markdownStreamKeepsClosedFencesAndFinishedBlocksFinal() {
    var stream = MarkdownStream()
    stream.update("Intro\n\n```js\na\n\nb\n")
    // A blank line inside an open fence is not a boundary.
    #expect(stream.stableBlocks == [.paragraph("Intro")])
    #expect(stream.tailBlocks == [.code(language: "js", text: "a\n\nb\n")])
    stream.update("Intro\n\n```js\na\n\nb\n```\n- item")
    #expect(stream.stableBlocks == [.paragraph("Intro"), .code(language: "js", text: "a\n\nb")])
    #expect(stream.tailBlocks == [.list(ordered: false, start: 1, items: ["item"])])
    stream.update("Intro\n\n```js\na\n\nb\n```\n- item\n## Next\n| t |")
    #expect(stream.stableBlocks.count == 4)
    // A pipe line without a delimiter row is not a table.
    #expect(stream.tailBlocks == [.paragraph("| t |")])
}

@Test func markdownStreamStartsOverWhenTextIsNotAnAppend() {
    var stream = MarkdownStream()
    stream.update("First paragraph\n\nSecond")
    stream.update("Replaced\n\nentirely")
    #expect(stream.blocks == [.paragraph("Replaced"), .paragraph("entirely")])
    #expect(stream.source == "Replaced\n\nentirely")
    stream.update("")
    #expect(stream.blocks.isEmpty)
}

@Test func markdownStreamCostFollowsNewTextNotMessageLength() {
    // 400 short paragraphs streamed 10 characters at a time. A full parse per update would read
    // about count² / 2 / chunk bytes (millions); the stream reads each final block once plus the open tail.
    let paragraph = String(repeating: "word ", count: 18) + "end.\n\n"
    let document = String(repeating: paragraph, count: 400)
    var stream = MarkdownStream()
    var updates = 0
    for prefix in prefixes(of: document, chunk: 10) {
        stream.update(prefix)
        updates += 1
    }
    #expect(stream.blocks.count == 400)
    #expect(stream.parsedByteCount <= document.utf8.count + updates * paragraph.utf8.count)
    #expect(stream.parsedByteCount < document.utf8.count * 12)
}

@Test func markdownStreamReadsALongOpenTableOnce() {
    // A 600-row table with no blank line stays open the whole time. Reparsing the open table per update would read
    // about rows² × row / 2 / chunk bytes (millions); the stream reads each complete line once plus the unfinished one.
    var document = "| Name | Value | Note |\n| :--- | ---: | :-: |\n"
    for row in 0 ..< 600 { document += "| row \(row) | \(row * 7) | `a|b` and \\| |\n" }
    let longestLine = document.split(separator: "\n").map(\.utf8.count).max() ?? 0
    var stream = MarkdownStream()
    var updates = 0
    for prefix in prefixes(of: document, chunk: 9) {
        stream.update(prefix)
        updates += 1
    }
    #expect(stream.blocks == Markdown.parse(document))
    #expect(stream.stableBlocks.isEmpty)
    guard case let .table(table) = stream.tailBlocks.first else {
        Issue.record("expected a table")
        return
    }
    #expect(table.rows.count == 600)
    #expect(table.rows[599] == ["row 599", "4193", "`a|b` and |"])
    #expect(stream.parsedByteCount <= document.utf8.count + updates * longestLine)
    #expect(stream.parsedByteCount < document.utf8.count * 4)
}

@Test func markdownStreamFinishesATableAtABlankLine() {
    var stream = MarkdownStream()
    stream.update("| a | b |\n|---|---|\n| 1 | 2 |\n")
    #expect(stream.stableBlocks.isEmpty)
    stream.update("| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter")
    #expect(stream.stableLength == "| a | b |\n|---|---|\n| 1 | 2 |\n\n".utf8.count)
    #expect(stream.stableBlocks == [.table(MarkdownTable(
        header: ["a", "b"], alignments: [.none, .none], rows: [["1", "2"]], source: "| a | b |\n|---|---|\n| 1 | 2 |"))])
    #expect(stream.tailBlocks == [.paragraph("After")])
}

@Test func streamedTextDeltasAppendAndCountOnlyRealChanges() {
    var transcript = Transcript()
    transcript.apply(.object(["type": .string("message_start"), "message": .object([
        "role": .string("assistant"),
        "content": .array([.object(["type": .string("text"), "text": .string("Hello")])]),
    ])]))
    let started = transcript.rowRevision
    func delta(_ text: String) -> JSONValue {
        .object(["type": .string("message_update"), "changes": .array([.object([
            "type": .string("text_delta"), "contentIndex": .number(0), "delta": .string(text),
        ])])])
    }
    transcript.apply(delta(", world"))
    transcript.apply(delta(""))
    transcript.apply(delta("!"))
    let text = transcript.streaming?.text
    #expect(text == "Hello, world!")
    #expect(transcript.rowRevision == started + 2)
}
