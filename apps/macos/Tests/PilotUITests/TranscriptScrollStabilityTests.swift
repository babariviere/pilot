import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func longAgentRepliesAreNeverFolded() {
    _ = NSApplication.shared
    let text = "## Report\n\n" + String(repeating: "A long line of agent analysis.\n\n", count: 60)
    let host = NSHostingView(rootView: RowView(row: .text(id: "a", text: text), messageExpansions: TranscriptExpansions())
        .fixedSize(horizontal: false, vertical: true).frame(width: 500))
    host.frame = NSRect(x: 0, y: 0, width: 500, height: 800)
    host.layoutSubtreeIfNeeded()
    // A folded preview is capped near six lines; a full reply is far taller.
    #expect(host.fittingSize.height > 1000)
}

@Test @MainActor func recreatedMarkdownViewsReusePreparedBlocks() async throws {
    let text = "# Cached heading \(UUID())\n\nBody with **bold** text."
    #expect(MarkdownRenderState(markdown: text).source == nil)
    let blocks = try await MarkdownRenderer.shared.prepare(text)
    PreparedMarkdownCache.shared.store(blocks, for: text)
    let state = MarkdownRenderState(markdown: text)
    #expect(state.source == text)
    #expect(state.blocks.count == blocks.count)
}

@Test @MainActor func streamingMarkdownReplacesItsPreviousCacheEntry() {
    let cache = PreparedMarkdownCache(countLimit: 4)
    cache.store([], for: "history")
    cache.store([], for: "H")
    cache.store([], for: "He", replacing: "H")
    cache.store([], for: "Hel", replacing: "He")
    #expect(cache.count == 2)
    #expect(cache.blocks(for: "history") != nil)
    #expect(cache.blocks(for: "H") == nil)
    #expect(cache.blocks(for: "Hel") != nil)
}

@Test @MainActor func recreatedInlineDiagramsKeepMeasuredHeight() {
    let source = "graph LR\n  A --> B \(UUID())"
    #expect(InlineDiagramLayout.cachedHeight(kind: .mermaid, source: source) == nil)
    InlineDiagramLayout(kind: .mermaid, source: source).update(312)
    #expect(InlineDiagramLayout.cachedHeight(kind: .mermaid, source: source) == 312)
    #expect(InlineDiagramLayout(kind: .mermaid, source: source).height == 312)
    #expect(InlineDiagramLayout().height == 180)
}

@Test @MainActor func recreatedArtifactCardsKeepMeasuredSize() {
    let reference = ArtifactReference(id: UUID().uuidString, sessionId: "s", title: "Mock", revision: 1)
    #expect(ArtifactInlineCache.contentSize(for: reference) == nil)
    ArtifactInlineCache.storeContentSize(CGSize(width: 700, height: 540), for: reference)
    #expect(ArtifactInlineCache.contentSize(for: reference) == CGSize(width: 700, height: 540))
}

