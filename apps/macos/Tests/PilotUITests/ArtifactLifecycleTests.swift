import AppKit
@testable import PilotCore
import SwiftUI
import Testing
import WebKit
@testable import Pilot

@Test @MainActor func inlineArtifactRemountDoesNotShrinkTheConversation() async throws {
    _ = NSApplication.shared
    let reference = ArtifactReference(id: UUID().uuidString, sessionId: "artifact-lifecycle", title: "Diagram", revision: 1)
    // Model an asynchronous renderer: its source/initial mount is much shorter than its result.
    // No library server, daemon or account is involved.
    let html = """
    <div id="content" style="height:100px">Diagram</div>
    <script>setTimeout(() => { document.getElementById('content').style.height='900px'; }, 200);</script>
    """
    let revision = ArtifactRevision(id: reference.id, sessionId: reference.sessionId, projectId: nil,
        title: reference.title, kind: .html, revision: 1, createdAt: 0, updatedAt: 0,
        source: html, html: html, libraries: [])
    ArtifactInlineCache.store(revision, for: reference)
    let retained = CGSize(width: 760, height: 900)
    ArtifactInlineCache.storeContentSize(retained, for: reference)

    let host = NSHostingView(rootView: ScrollView {
        LazyVStack(spacing: 0) {
            Color.clear.frame(height: 1800)
            ArtifactCard(reference: reference)
            Color.clear.frame(height: 1800)
        }.frame(width: 760)
    })
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
        styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    window.orderBack(nil)
    defer { window.close() }
    host.layoutSubtreeIfNeeded()
    let scroll = try #require(artifactDescendant(NSScrollView.self, in: host))
    var mounts = 0
    for _ in 0..<3 {
        // At the viewport boundary a short startup measurement used to shrink the row,
        // bringing it into view again and repeating the teardown/re-expansion cycle.
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 1400))
        scroll.reflectScrolledClipView(scroll.contentView)
        for _ in 0..<30 {
            try await Task.sleep(for: .milliseconds(50))
            #expect(ArtifactInlineCache.contentSize(for: reference) == retained)
        }
        if artifactDescendant(WKWebView.self, in: host) != nil { mounts += 1 }
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
        try await Task.sleep(for: .milliseconds(150))
        #expect(ArtifactInlineCache.contentSize(for: reference) == retained)
    }
    #expect(mounts == 3, "Exercise live WebKit mounts, not just cached placeholders")
}

@MainActor private func artifactDescendant<T: NSView>(_ type: T.Type, in view: NSView) -> T? {
    if let match = view as? T { return match }
    for child in view.subviews {
        if let match = artifactDescendant(type, in: child) { return match }
    }
    return nil
}

@Test @MainActor func slowMermaidSourceDoesNotReplaceTheSavedDiagramSize() async throws {
    _ = NSApplication.shared
    let state = ArtifactRenderState()
    let retained = CGSize(width: 760, height: 900)
    state.contentSize = retained
    let coordinator = ArtifactWebView.Coordinator(state: state)
    coordinator.measurementKind = .html
    coordinator.awaitingMermaid = true
    let view = ArtifactWebView.makeSandboxView(coordinator: coordinator,
        libraries: ArtifactLibraryHandler(libraries: [], client: AppModel.shared.client), inline: true)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 900),
        styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    window.orderBack(nil)
    defer { ArtifactWebView.dismantleNSView(view, coordinator: coordinator); window.close() }
    coordinator.install(in: view, document: ArtifactSandboxPolicy.document("""
    <style>html,body,pre{margin:0;padding:0}</style>
    <pre class="mermaid" style="height:100px">flowchart TD A --> B</pre>
    """))
    for _ in 0..<100 {
        if !state.loading || state.error != nil { break }
        try await Task.sleep(for: .milliseconds(50))
    }
    try #require(!state.loading && state.error == nil)
    // Source remains unchanged longer than the normal initial-settling window.
    for _ in 0..<30 {
        try await Task.sleep(for: .milliseconds(50))
        #expect(state.contentSize == retained)
    }
    // Once rendering completes, normal measurement resumes (including real shrinking).
    _ = try await view.evaluateJavaScript("""
    document.querySelector('.mermaid').outerHTML =
      '<div class="mermaid"><svg width="760" height="600" style="display:block"></svg></div>';
    """)
    for _ in 0..<60 {
        if state.contentSize?.height == 600 { break }
        try await Task.sleep(for: .milliseconds(50))
    }
    #expect(state.contentSize?.height == 600)
}
