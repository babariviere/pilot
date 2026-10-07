import Testing
@testable import PilotCore

@Test func completedDiagramFencesUseCaseInsensitiveFirstInfoToken() {
    for (info, kind) in [("svg", MarkdownDiagramKind.svg), ("SVG title=example", .svg),
                         ("mermaid", .mermaid), ("MeRmAiD\tflowchart", .mermaid)] {
        #expect(Markdown.parse("```\(info)\n  source\n```") == [.diagram(kind: kind, text: "  source")])
    }
    #expect(MarkdownDiagramKind.svg.rawValue == "svg")
    #expect(MarkdownDiagramKind.mermaid.rawValue == "mermaid")
}

@Test func diagramFencesStayCodeWhileStreamingUntilMatchingClose() {
    let opening = "````Mermaid title\n"
    for text in ["", "graph TD", "graph TD\nA-->B", "graph TD\n```", "graph TD\n```` still code"] {
        #expect(Markdown.parse(opening + text) == [.code(language: "Mermaid title", text: text)])
    }
    #expect(Markdown.parse(opening + "graph TD\n````") == [.diagram(kind: .mermaid, text: "graph TD")])
    #expect(Markdown.parse("```svg") == [.code(language: "svg", text: "")])
}

@Test func fenceClosuresRequireEnoughBackticksAndOnlyTrailingWhitespace() {
    #expect(Markdown.parse("````svg\n<svg/>\n```\n```` extra\n````\t \r") == [
        .diagram(kind: .svg, text: "<svg/>\n```\n```` extra"),
    ])
    #expect(Markdown.parse("```svg\n<svg/>\n``````  \t") == [.diagram(kind: .svg, text: "<svg/>")])
    #expect(Markdown.parse("`````js\n```\n````\n`````suffix\n``````") == [
        .code(language: "js", text: "```\n````\n`````suffix"),
    ])
    #expect(Markdown.parse("``svg\ntext\n``") == [.paragraph("``svg\ntext\n``")])
}

@Test func ordinaryAndUnknownFenceLanguagesKeepTheirCodeAPI() {
    for language: String? in [nil, "js", "SVGish", "mermaid-js", "unknown title", "typescript"] {
        #expect(Markdown.parse("```\(language ?? "")\ncontent\n```") == [.code(language: language, text: "content")])
    }
    #expect(Markdown.parse("````javascript\nconst ticks = '```';\n````") == [
        .code(language: "javascript", text: "const ticks = '```';"),
    ])
}

@Test func multipleDiagramBlocksPreserveOtherMarkdownAndSourceWhitespace() {
    #expect(Markdown.parse("""
    # Diagrams

    ```SVG
    <svg>
      <text>hello</text>
    </svg>
    ```

    Between diagrams.
    ````mermaid
    graph LR; A-->B
    `````
    ```python
    print("hello")
    ```
    ```mermaid
    streaming
    """) == [
        .heading(level: 1, text: "Diagrams"),
        .diagram(kind: .svg, text: "<svg>\n  <text>hello</text>\n</svg>"),
        .paragraph("Between diagrams."),
        .diagram(kind: .mermaid, text: "graph LR; A-->B"),
        .code(language: "python", text: "print(\"hello\")"),
        .code(language: "mermaid", text: "streaming"),
    ])
    #expect(Markdown.parse("```svg\r\n<svg/>\r\n```\r\n") == [.diagram(kind: .svg, text: "<svg/>\r")])
    #expect(Markdown.parse("```svg\n```") == [.diagram(kind: .svg, text: "")])
}
