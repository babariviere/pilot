import AppKit
@testable import PilotCore
import PilotVisualsKit
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func inlineArtifactLayoutKeepsTheReadingColumnWhenResized() {
    _ = NSApplication.shared
    for width: CGFloat in [320, 760, 1000, 1200] {
        var proposed: CGFloat?
        let view = NSHostingView(rootView: InlineArtifactLayout {
            GeometryReader { geometry in Color.blue.onAppear { proposed = geometry.size.width } }
        }.fixedSize(horizontal: false, vertical: true).frame(width: width))
        view.frame = NSRect(x: 0, y: 0, width: width, height: 900)
        view.layoutSubtreeIfNeeded()
        let expected = ArtifactViewerLayout.inlineSize(availableWidth: width)
        #expect(expected.width == min(width, 760))
        #expect(view.fittingSize.height == expected.height)
        // The card's content is laid out at the column width, never wider.
        if let proposed { #expect(proposed == expected.width) }
    }
}

@Test @MainActor func inlineArtifactLayoutHonorsContentInBothDirections() {
    _ = NSApplication.shared
    let view = NSHostingView(rootView: InlineArtifactLayout(contentSize: CGSize(width: 1650, height: 700)) {
        Color.blue
    }.fixedSize(horizontal: false, vertical: true).frame(width: 1800))
    view.frame = NSRect(x: 0, y: 0, width: 1800, height: 1600)
    view.layoutSubtreeIfNeeded()
    #expect(view.fittingSize == CGSize(width: 1800, height: 700))
}

@Test @MainActor func artifactRowsUseTheSameReadableColumnAsText() {
    _ = NSApplication.shared
    let reference = ArtifactReference(id: "column-test", sessionId: "test", title: "Column", revision: 1)
    for width: CGFloat in [320, 760, 1000, 1400] {
        // The offscreen card reserves its viewport without needing a renderer or a daemon.
        let view = NSHostingView(rootView: RowView(row: .artifact(id: "artifact", reference: reference))
            .fixedSize(horizontal: false, vertical: true).frame(width: width))
        view.frame = NSRect(x: 0, y: 0, width: width, height: 900)
        view.layoutSubtreeIfNeeded()
        #expect(view.fittingSize.height == ArtifactViewerLayout.inlineSize(availableWidth: min(width, Theme.column)).height)
    }
}

@Test @MainActor func measuredInlineArtifactLayoutHugsShortContentAtNarrowAndWideWidths() {
    _ = NSApplication.shared
    for width: CGFloat in [320, 760, 1200] {
        for height: CGFloat in [1, 120, 240, 2000] {
            let content = CGSize(width: 240, height: height)
            let view = NSHostingView(rootView: InlineArtifactLayout(contentSize: content) {
                Color.blue
            }.fixedSize(horizontal: false, vertical: true).frame(width: width))
            view.frame = NSRect(x: 0, y: 0, width: width, height: 1800)
            view.layoutSubtreeIfNeeded()
            #expect(view.fittingSize == CGSize(width: width, height: min(720, max(48, height))))
        }
    }
}

@Test @MainActor func measuredNativeVisualLayoutHasNoHeightCeiling() {
    _ = NSApplication.shared
    for width: CGFloat in [320, 760, 1200] {
        for height: CGFloat in [120, 720, 721, 2000, 9000] {
            let view = NSHostingView(rootView: InlineArtifactLayout(
                contentSize: CGSize(width: 760, height: height), visual: true
            ) { Color.clear }.fixedSize(horizontal: false, vertical: true).frame(width: width))
            view.frame = NSRect(x: 0, y: 0, width: width, height: 600)
            view.layoutSubtreeIfNeeded()
            #expect(view.fittingSize == CGSize(width: width, height: height))
        }
    }
}

@Test @MainActor func offscreenNativeVisualCardsReserveTheirFullCachedHeight() {
    _ = NSApplication.shared
    let reference = ArtifactReference(id: UUID().uuidString, sessionId: "visual-layout", title: "Long visual", revision: 1)
    let host = AppModel.shared.client.hostIdentity
    ArtifactInlineCache.store(ArtifactRevision(
        id: reference.id, sessionId: reference.sessionId, projectId: nil, title: reference.title, kind: .visual,
        revision: 1, createdAt: 0, updatedAt: 0, source: "", html: "", libraries: []
    ), for: reference, host: host)
    ArtifactInlineCache.storeContentSize(CGSize(width: 760, height: 4000), for: reference, host: host)
    // Recreate the actual card twice without mounting a renderer, as when scrolling back or reopening a chat.
    for _ in 0..<2 {
        let view = NSHostingView(rootView: ArtifactCard(reference: reference, host: host)
            .fixedSize(horizontal: false, vertical: true).frame(width: 760))
        view.frame = NSRect(x: 0, y: 0, width: 760, height: 600)
        view.layoutSubtreeIfNeeded()
        #expect(view.fittingSize.height == 4000)
    }
}

private struct MeasuredNativeVisual: View {
    let tree: VisualTree
    let model: VisualArtifactModel
    @ObservedObject var render: ArtifactRenderState

    var body: some View {
        InlineArtifactLayout(contentSize: render.contentSize, visual: true) {
            VisualArtifactContent(tree: tree, model: model, render: render)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

@Test(.timeLimit(.minutes(1))) @MainActor
func longNativeVisualTextReflowsAndShrinksWithoutAnInlineScrollView() async throws {
    _ = NSApplication.shared
    let clock = ContinuousClock()
    let started = clock.now
    let text = String(repeating: "Long native visual text wraps with the reading column and scrolls with the conversation. ", count: 150)
    func tree(_ text: String) throws -> VisualTree {
        try VisualTree(["api": 1, "root": ["type": "text", "runs": [["text": .string(text)]]]])
    }
    let long = try tree(text)
    let short = try tree("Short visual")
    let render = ArtifactRenderState()
    let model = VisualArtifactModel() // No engine start: the test supplies the decoded tree directly.
    let view = NSHostingView(rootView: MeasuredNativeVisual(tree: long, model: model, render: render).frame(width: 760))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 600),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    window.orderBack(nil)
    defer { window.close() }

    func settle(_ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            view.layoutSubtreeIfNeeded()
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        Issue.record("Native visual geometry did not settle")
    }
    try await settle { (render.contentSize?.height ?? 0) > 720 && view.fittingSize.height == render.contentSize?.height }
    let wideHeight = try #require(render.contentSize?.height)
    let wideElapsed = started.duration(to: clock.now)
    #expect(!containsArtifactScrollView(view))

    view.rootView = MeasuredNativeVisual(tree: long, model: model, render: render).frame(width: 320)
    try await settle { (render.contentSize?.height ?? 0) > wideHeight && view.fittingSize.height == render.contentSize?.height }
    let narrowHeight = try #require(render.contentSize?.height)
    #expect(!containsArtifactScrollView(view))

    view.rootView = MeasuredNativeVisual(tree: short, model: model, render: render).frame(width: 320)
    try await settle { (render.contentSize?.height ?? 1000) < 100 && view.fittingSize.height == 48 }
    #expect(!containsArtifactScrollView(view))

    // Only the expanded viewer owns a nested viewport.
    let expanded = NSHostingView(rootView: VisualArtifactContent(tree: long, model: model, inline: false, render: render)
        .frame(width: 320, height: 400))
    expanded.frame = NSRect(x: 0, y: 0, width: 320, height: 400)
    expanded.layoutSubtreeIfNeeded()
    #expect(containsArtifactScrollView(expanded))
    print("Native visual layout: \(text.utf8.count) bytes, wide \(wideHeight) pt in \(wideElapsed), narrow \(narrowHeight) pt; reflow/shrink total \(started.duration(to: clock.now))")
}

@MainActor private func containsArtifactScrollView(_ view: NSView) -> Bool {
    view is NSScrollView || view.subviews.contains { containsArtifactScrollView($0) }
}
