import AppKit
import Foundation
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test func nativeMermaidLaysOutCommonDiagramsWithANaturalSize() throws {
    let sources = [
        "flowchart LR\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]",
        "sequenceDiagram\n  User->>App: Send\n  App-->>User: Reply",
        "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Working",
        "classDiagram\n  class Card\n  Card --> State",
        "pie\n  \"a\" : 1\n  \"b\" : 2",
    ]
    for source in sources {
        let layout = try #require(NativeMermaid.makeLayout(source))
        #expect(layout.natural.width > 0 && layout.natural.height > 0)
        #expect(!layout.altText.isEmpty)
    }
}

/// Fixed by scripts/patches/mermaidkit-quoted-edge-labels.patch in the vendored MermaidKit.
@Test func nativeMermaidDrawsQuotedEdgeLabelsWithoutQuotes() throws {
    let layout = try #require(NativeMermaid.makeLayout("flowchart TD\n  R{Review?} -->|\"Yes\"| A[Approve]\n  R -- \"No\" --> B[Fix]"))
    #expect(Set(layout.edgeLabels) == ["Yes", "No"])
}

@Test func nativeMermaidFallsBackWhenTheParserWouldDropALinkOrCannotParse() {
    // Real chat diagrams the native parser reads without some of their links.
    #expect(NativeMermaid.makeLayout("""
    flowchart LR
      D[fan-out] -- "per-session queues\\noverflow = resync that chat only" --> WS((WebSocket))
      WS --> UI[App]
    """) == nil)
    #expect(NativeMermaid.makeLayout("flowchart LR\n  F -.blocks queue.-> Q\n  Q --> R") == nil)
    #expect(NativeMermaid.makeLayout("flowchart TD\n  A[Unclosed --> B\n  B --> ") == nil)
    #expect(NativeMermaid.makeLayout("notADiagram\n  A --> B") == nil)
}

@Test func nativeMermaidLayoutIsCachedPerSource() {
    // A unique label keeps other tests' cache entries out of the way.
    let source = "flowchart LR\n  A --> B[Node \(UUID().uuidString.prefix(8))]"
    let first = NativeMermaid.layout(source)
    #expect(first != nil)
    #expect(NativeMermaid.layout(source) == first)
}

@Test func nativeMermaidDrawsAtTheRequestedPixelSizeAndCachesTheBitmap() async throws {
    let source = "flowchart LR\n  A[Draw] --> B[Cache \(UUID().uuidString.prefix(8))]"
    let layout = try #require(NativeMermaid.layout(source))
    let key = NativeMermaid.ImageKey(source: source, dark: true, width: 300, height: 120)
    #expect(NativeMermaid.cachedImage(key) == nil)
    let image = try #require(await NativeMermaid.image(layout, key: key))
    #expect(image.width == 300 && image.height == 120)
    #expect(NativeMermaid.cachedImage(key) != nil)
}

@Test @MainActor func nativeDiagramBlocksTakeTheirHeightFromTheNaturalSize() {
    _ = NSApplication.shared
    for (natural, width, height) in [(CGSize(width: 640, height: 320), CGFloat(760), CGFloat(344)),
                                     (CGSize(width: 400, height: 3000), 760, 480),
                                     (CGSize(width: 640, height: 320), 320, 172)] {
        let view = NSHostingView(rootView: NativeDiagramFrame(natural: natural) { Color.blue }
            .fixedSize(horizontal: false, vertical: true).frame(width: width))
        view.frame = NSRect(x: 0, y: 0, width: width, height: 900)
        view.layoutSubtreeIfNeeded()
        #expect(view.fittingSize == CGSize(width: width, height: height))
    }
}
