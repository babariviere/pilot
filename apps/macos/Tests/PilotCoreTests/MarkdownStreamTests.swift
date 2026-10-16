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
    #expect(stream.tailBlocks == [.table(["| t |"])])
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

