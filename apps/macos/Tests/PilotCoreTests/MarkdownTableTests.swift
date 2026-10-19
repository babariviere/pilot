import Testing
@testable import PilotCore

private func table(_ source: String) -> MarkdownTable? {
    let blocks = Markdown.parse(source)
    guard blocks.count == 1, case let .table(table) = blocks[0] else { return nil }
    return table
}

@Test func parsesHeaderAlignmentsBodyAndSource() throws {
    let source = "| Name | Left | Center | Right |\n| --- | :--- | :---: | ---: |\n| **a** | `x` | [l](https://e.com) | 1 |\n| b | | c | 2 |"
    let parsed = try #require(table(source))
    #expect(parsed.header == ["Name", "Left", "Center", "Right"])
    #expect(parsed.alignments == [.none, .leading, .center, .trailing])
    #expect(parsed.rows == [["**a**", "`x`", "[l](https://e.com)", "1"], ["b", "", "c", "2"]])
    #expect(parsed.columnCount == 4)
    #expect(parsed.source == source)
}

@Test func outerPipesAreOptional() {
    for source in ["a | b\n--- | --:\n1 | 2", "| a | b\n|---|--:\n| 1 | 2", "a | b |\n---|--:|\n1 | 2 |"] {
        let parsed = table(source)
        #expect(parsed?.header == ["a", "b"], "\(source.debugDescription)")
        #expect(parsed?.alignments == [.none, .trailing])
        #expect(parsed?.rows == [["1", "2"]])
        #expect(parsed?.source == source)
    }
    // One column needs a pipe on each row to have a separator.
    #expect(table("| only |\n| --- |\n| one |")?.rows == [["one"]])
}

@Test func escapedAndCodeSpanPipesStayInTheirCell() {
    #expect(MarkdownTable.cells(#"| a \| b | c |"#) == ["a | b", "c"])
    #expect(MarkdownTable.cells("| `a|b` | c |") == ["`a|b`", "c"])
    #expect(MarkdownTable.cells("| ``a|`b`` | c |") == ["``a|`b``", "c"])
    // An escaped pipe inside a code span loses its backslash too, as on GitHub.
    #expect(MarkdownTable.cells(#"| `a\|b` | c |"#) == ["`a|b`", "c"])
    // Other escapes are left for the inline parser; an escaped backslash does not escape the pipe after it.
    #expect(MarkdownTable.cells(#"| \*a\* | b\\| c |"#) == [#"\*a\*"#, #"b\\"#, "c"])
    // An unmatched backtick is literal, so the pipe after it separates cells.
    #expect(MarkdownTable.cells("| `a | b |") == ["`a", "b"])
    #expect(MarkdownTable.cells("no separator `a|b`") == nil)
    #expect(MarkdownTable.cells(#"escaped \| only"#) == nil)
    #expect(MarkdownTable.cells("|") == [])
    #expect(MarkdownTable.cells("| |") == [""])
    #expect(MarkdownTable.cells("|| x") == ["", "x"])
}

@Test func raggedRowsArePaddedOrWidenedWithoutLosingCells() throws {
    let parsed = try #require(table("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n| |"))
    #expect(parsed.columnCount == 3)
    #expect(parsed.header == ["a", "b", ""])
    #expect(parsed.alignments == [.none, .none, .none])
    #expect(parsed.rows == [["1", "", ""], ["1", "2", "3"], ["", "", ""]])
}

@Test func onlyAValidHeaderAndDelimiterMakeATable() {
    // Pipe lines without a delimiter row are paragraph text.
    #expect(Markdown.parse("| a | b |\n| 1 | 2 |") == [.paragraph("| a | b |\n| 1 | 2 |")])
    // A delimiter row must have one cell per header cell and only dashes with optional colons.
    #expect(Markdown.parse("| a | b |\n|---|") == [.paragraph("| a | b |\n|---|")])
    #expect(Markdown.parse("| a | b |\n|---|-x-|") == [.paragraph("| a | b |\n|---|-x-|")])
    #expect(Markdown.parse("| a | b |\n|:|:|") == [.paragraph("| a | b |\n|:|:|")])
    // A delimiter row with nothing above it, and a bare rule, are not tables.
    #expect(Markdown.parse("|---|---|") == [.paragraph("|---|---|")])
    #expect(Markdown.parse("a | b\n---") == [.paragraph("a | b"), .rule])
    // A header without a complete delimiter yet, as while streaming, stays a paragraph until the delimiter arrives.
    #expect(Markdown.parse("| a | b |\n|--") == [.paragraph("| a | b |\n|--")])
    #expect(table("| a | b |\n|--|-") != nil)
}

@Test func aTableTakesTheLastParagraphLineAsHeaderAndEndsAtOtherBlocks() {
    let header = MarkdownTable(header: ["a"], alignments: [.none], rows: [["1"]], source: "| a |\n|---|\n| 1 |")
    #expect(Markdown.parse("Intro\nmore\n| a |\n|---|\n| 1 |\nafter") == [
        .paragraph("Intro\nmore"), .table(header), .paragraph("after"),
    ])
    #expect(Markdown.parse("| a |\n|---|\n| 1 |\n> q") == [.table(header), .quote("q")])
    #expect(Markdown.parse("| a |\n|---|\n| 1 |\n- i") == [.table(header), .list(ordered: false, start: 1, items: ["i"])])
    #expect(Markdown.parse("| a |\n|---|\n| 1 |\n## H") == [.table(header), .heading(level: 2, text: "H")])
    #expect(Markdown.parse("| a |\n|---|\n| 1 |\n---") == [.table(header), .rule])
    #expect(Markdown.parse("- i\n| a |\n|---|\n| 1 |") == [.list(ordered: false, start: 1, items: ["i"]), .table(header)])
}

@Test func fencedTablesStayCode() {
    let fenced = "| a | b |\n|---|---|\n| 1 | 2 |"
    #expect(Markdown.parse("```markdown\n\(fenced)\n```") == [.code(language: "markdown", text: fenced)])
    #expect(Markdown.parse("| a | b |\n```\n|---|---|\n```") == [
        .paragraph("| a | b |"), .code(language: nil, text: "|---|---|"),
    ])
    // A fence ends an open table.
    #expect(Markdown.parse("| a |\n|---|\n```\n| b |\n```") == [
        .table(MarkdownTable(header: ["a"], alignments: [.none], rows: [], source: "| a |\n|---|")),
        .code(language: nil, text: "| b |"),
    ])
}

@Test func tableSourceKeepsLinesAsWritten() throws {
    let source = "  | a |  \r\n  |:-:|\r\n\t| ü 🙂 |"
    let parsed = try #require(table(source))
    #expect(parsed.source == source)
    #expect(parsed.alignments == [.center])
    #expect(parsed.rows == [["ü 🙂"]])
}

