import AppKit
import PilotCore
import Testing
import WebKit
@testable import Pilot

// Each kind and placement is its own serialized case, so the one-minute limit covers one web view rather than
// four: the whole matrix took 44 to 61 seconds on loaded CI runners and timed out.
@Test(.serialized, .timeLimit(.minutes(1)), arguments: [ArtifactKind.html, .react], [false, true]) @MainActor
func artifactHeightRespectsNestedClippingWhileKeepingVisibleOverflow(kind: ArtifactKind, inline: Bool) async throws {
    _ = NSApplication.shared
    let client = PilotClient(baseURL: URL(string: "http://127.0.0.1:1")!)
    let html = "<style>body{margin:0;padding:0;font:16px/32px system-ui}</style><div id='artifact-root'></div>"
    let values: [String: Any] = ["id": "height", "sessionId": "test", "title": "Height", "kind": kind.rawValue,
        "revision": 1, "createdAt": 1, "updatedAt": 1, "source": "", "html": html, "libraries": []]
    let revision = try JSONDecoder().decode(ArtifactRevision.self, from: JSONSerialization.data(withJSONObject: values))
    let state = ArtifactRenderState()
    let coordinator = ArtifactWebView.Coordinator(state: state)
    let view = ArtifactWebView.makeSandboxView(coordinator: coordinator,
        libraries: ArtifactLibraryHandler(libraries: [], client: client), inline: inline)
    view.frame = CGRect(x: 0, y: 0, width: 760, height: 570)
    // Production samples a window-backed renderer. A detached WKWebView can throttle
    // JavaScript and layout, turning this matrix of IPC reads into a timing test.
    let window = NSWindow(contentRect: view.frame, styleMask: .borderless,
                          backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    let container = NSView(frame: view.frame)
    window.contentView = container
    container.addSubview(view)
    window.orderBack(nil)
    defer {
        ArtifactWebView.dismantleNSView(view, coordinator: coordinator)
        view.removeFromSuperview()
        window.close()
    }
    coordinator.install(in: view, document: ArtifactPreviewDocument.document(revision, inline: inline))
    let deadline = ContinuousClock.now + .seconds(10)
    while state.loading && state.error == nil && ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(state.error == nil)
    try #require(!state.loading)

    func replaceContent(_ markup: String) async throws {
        let json = try JSONSerialization.data(withJSONObject: [markup])
        let string = try #require(String(data: json, encoding: .utf8))
        _ = try await view.evaluateJavaScript("document.getElementById('artifact-root').innerHTML=(\(string))[0]")
    }

    // An asynchronously mounted Memory mock has a fixed flex shell and a scrolling
    // tree. Clipped row text and SVG icons must not request thousands of host points.
    for overflow in ["auto", "scroll", "hidden", "clip"] {
        try await replaceContent("""
        <div style='height:120px;display:flex;flex-direction:column'>
          <header style='height:20px;flex:none'>Memory tree</header>
          <div id='pane' style='flex:1;min-height:0;overflow:\(overflow)'>
            <div id='rows' style='height:2000px;position:relative'>Tree rows
              <svg viewBox='0 0 10 10' width='9' height='9' style='position:absolute;top:1800px'>
                <path d='M3 1L7 5L3 9' fill='none' stroke='black'/>
              </svg>
            </div>
          </div>
        </div>
        """)
        for width: CGFloat in [320, 760] {
            view.setFrameSize(CGSize(width: width, height: 570))
            for update in [
                "document.getElementById('rows').style.height='4000px'",
                "document.getElementById('pane').scrollTop=200",
                "document.getElementById('rows').style.height='2000px'",
            ] {
                _ = try await view.evaluateJavaScript(update)
                let sample = try await coordinator.readContentSize(view, kind: kind)
                let measured = try #require(sample)
                #expect(measured.height == 120, "\(kind) inline=\(inline) overflow=\(overflow)")
                #expect(!ArtifactViewerLayout.inlineClipsHeight(contentSize: measured))
                let fitted = ArtifactViewerLayout.inlineSize(availableWidth: width, contentSize: measured)
                #expect(fitted == CGSize(width: width, height: 120))
                view.setFrameSize(fitted)
                let afterResize = try await coordinator.readContentSize(view, kind: kind)
                #expect(afterResize?.height == 120)
            }
        }
    }

    // Removing the unbounded Range must not crop direct text, visible overflow or
    // positioned descendants whose containing block is outside the body.
    for (markup, height) in [
        ("Direct text", 32),
        ("<div style='height:0'><div style='height:120px'>Visible overflow</div></div>", 120),
        ("<div style='position:absolute;top:200px;height:40px;width:240px'>Positioned</div>", 240),
        ("<div style='height:0'><div style='position:absolute;top:200px;height:40px;width:240px'>Positioned</div></div>", 240),
        ("<div style='height:120px;contain:paint'><div style='position:absolute;top:1800px;height:120px;width:100px'>Clipped</div></div>", 120),
    ] {
        try await replaceContent(markup)
        let measured = try await coordinator.readContentSize(view, kind: kind)
        #expect(measured?.height == CGFloat(height))
    }
    try await replaceContent("<svg viewBox='0 0 640 320' style='display:block;width:640px;max-width:100%;height:auto'><rect width='640' height='320'/></svg>")
    view.setFrameSize(CGSize(width: 320, height: 570))
    let drawing = try await coordinator.readContentSize(view, kind: kind)
    #expect(drawing == CGSize(width: 640, height: 160))

    // Keep the remount fix's renderer-readiness gate when combining it with clipping.
    coordinator.awaitingMermaid = true
    try await replaceContent("<pre class='mermaid'>Unrendered diagram source</pre>")
    let pendingDiagram = try await coordinator.readContentSize(view, kind: kind)
    #expect(pendingDiagram == nil)
    try await replaceContent("<div class='mermaid'><svg viewBox='0 0 640 320' style='display:block;width:640px;max-width:100%;height:auto'><rect width='640' height='320'/></svg></div>")
    let readyDiagram = try await coordinator.readContentSize(view, kind: kind)
    #expect(readyDiagram == CGSize(width: 640, height: 160))
}
