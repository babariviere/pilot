import Foundation
import Testing
@testable import PilotCore

@Test func mermaidFlowchartHeadersAreFoundAfterFrontMatterAndComments() {
    #expect(MermaidSource.isFlowchart("flowchart LR\n A --> B"))
    #expect(MermaidSource.isFlowchart("graph TD; A --> B"))
    #expect(MermaidSource.isFlowchart("---\ntitle: Flow\n---\n%% note\n\nflowchart TB\n A --> B"))
    #expect(!MermaidSource.isFlowchart("sequenceDiagram\n A->>B: hi"))
    #expect(!MermaidSource.isFlowchart(""))
}

@Test func mermaidStatementsKeepWrappedLabelsWithTheirLink() {
    let source = """
    flowchart TD
      A --> B["First line
      second line"]
      %% a comment
      C --> D; D --> E
      F -- "label; with semicolon" --> G
    """
    #expect(MermaidSource.statements(source) == [
        "A --> B[\"First line\n  second line\"]",
        "C --> D", "D --> E",
        "F -- \"label; with semicolon\" --> G",
    ])
}

@Test func mermaidLinkStatementsIgnoreLabelsKeywordsAndOtherDiagrams() {
    #expect(MermaidSource.declaresLink("A --> B"))
    #expect(MermaidSource.declaresLink("A -.-> B"))
    #expect(MermaidSource.declaresLink("A == \"thick\" ==> B"))
    #expect(MermaidSource.declaresLink("A ~~~ B"))
    #expect(MermaidSource.declaresLink("A -- \"x = y\" --> B"))
    // Operators inside labels or quotes are not links.
    #expect(!MermaidSource.declaresLink("A[\"a -- b\"]"))
    #expect(!MermaidSource.declaresLink("A(\"x ==> y\")"))
    #expect(!MermaidSource.declaresLink("linkStyle 0 stroke:#f66,stroke-width:2px"))
    #expect(!MermaidSource.declaresLink("classDef store fill:#eef,stroke:#88a"))
    #expect(!MermaidSource.declaresLink("subgraph S[\"a -- b\"]"))
    #expect(MermaidSource.linkStatements("flowchart LR\n A[x] --> B\n B\n linkStyle 0 stroke:red") == ["A[x] --> B"])
    #expect(MermaidSource.linkStatements("sequenceDiagram\n A-->>B: hi").isEmpty)
}
