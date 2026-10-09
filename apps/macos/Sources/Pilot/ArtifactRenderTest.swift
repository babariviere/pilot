import AppKit
import Network
import PilotCore
import SwiftUI
import WebKit

/// Explicit CLI-only verification. Evaluating JavaScript here is test instrumentation,
/// not a script message handler or capability exposed to artifact code.
@MainActor
enum ArtifactRenderTest {
    static func run(directory: URL) async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let libraryPath = ProcessInfo.processInfo.environment["PILOT_ARTIFACT_TEST_LIBRARY"]
                ?? "node_modules/echarts/dist/echarts.min.js"
            let library = try Data(contentsOf: URL(filePath: libraryPath))
            let mermaidPath = ProcessInfo.processInfo.environment["PILOT_ARTIFACT_TEST_MERMAID"]
                ?? "node_modules/mermaid/dist/mermaid.min.js"
            let mermaid = try Data(contentsOf: URL(filePath: mermaidPath))
            let server = try ArtifactTestServer(library: library, mermaid: mermaid)
            defer { server.stop() }
            try await wait("HTTP server") { server.port != nil }
            let base = URL(string: "http://127.0.0.1:\(server.port!)")!
            let client = PilotClient(baseURL: base)
            NSApp.appearance = NSAppearance(named: .aqua)
            for window in NSApp.windows { window.orderOut(nil) }

            // With and without CSP: the second phase proves the content rule list is
            // an independent network boundary, not just a redundant policy string.
            for csp in [true, false] {
                let state = ArtifactRenderState()
                let coordinator = ArtifactWebView.Coordinator(state: state)
                let handler = ArtifactLibraryHandler(libraries: [.echarts], client: client)
                let view = ArtifactWebView.makeSandboxView(coordinator: coordinator, libraries: handler)
                view.frame = CGRect(x: 0, y: 0, width: 760, height: 480)
                let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = view
                window.orderFront(nil)
                defer {
                    ArtifactWebView.dismantleNSView(view, coordinator: coordinator)
                    window.close()
                }
                let html = """
                <html><head><style>body{font:16px system-ui;background:#fafafa;padding:20px}h2{margin:0 0 8px}</style>
                <script src="pilot-artifact://library/echarts"></script>
                <script src="\(base)/blocked-script"></script>
                <script src="pilot-artifact://library/fs"></script>
                <script src="data:text/javascript,window.dataScriptRan=true"></script>
                </head><body><h2>Offline artifact, native WebKit</h2>
                <div id="chart" style="width:680px;height:340px"></div>
                <img id="embedded" width="28" height="28"><img id="blobImage" width="28" height="28">
                <span id="animated" style="display:inline-block;color:#5d79d6">●</span>
                <script>
                window.probe={fetchBlocked:false,customFetchBlocked:false,blobScriptBlocked:false};
                window.nativeBridgePresent=!!(window.webkit && window.webkit.messageHandlers);
                window.chartReady=false;
                window.networkGuardOK=['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','WebTransport'].every(name=>{
                  try { Object.defineProperty(window,name,{value:function(){}}); } catch {}
                  return window[name]===undefined && Object.getOwnPropertyDescriptor(window,name).configurable===false;
                });
                const frame=document.createElement('iframe');frame.src='about:blank';document.body.append(frame);
                window.frameGuardOK=!frame.contentWindow || ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','WebTransport'].every(name=>frame.contentWindow[name]===undefined);
                window.frameGuardDelayedOK=false;
                setTimeout(()=>{window.frameGuardDelayedOK=!frame.contentWindow || ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','WebTransport'].every(name=>frame.contentWindow[name]===undefined);},150);
                window.animationFrames=0; window.animationFinished=false;
                const tick=()=>{window.animationFrames++; if(window.animationFrames<10)requestAnimationFrame(tick);};requestAnimationFrame(tick);
                document.getElementById('animated').animate([{transform:'translateX(0)'},{transform:'translateX(30px)'}],{duration:200,fill:'forwards'}).onfinish=()=>window.animationFinished=true;
                if(window.echarts){echarts.init(document.getElementById('chart')).setOption({animation:false,
                  title:{text:'Quarterly output'},xAxis:{data:['Q1','Q2','Q3','Q4']},yAxis:{},
                  series:[{type:'bar',data:[12,24,18,36],itemStyle:{color:'#5d79d6'}}]});window.chartReady=true;}
                const svg='<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="28" height="28" fill="green"/></svg>';
                document.getElementById('embedded').src='data:image/svg+xml,'+encodeURIComponent(svg);
                document.getElementById('blobImage').src=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
                fetch('\(base)/blocked-fetch').catch(()=>window.probe.fetchBlocked=true);
                fetch('pilot-artifact://library/echarts').catch(()=>window.probe.customFetchBlocked=true);
                const img=new Image();img.src='\(base)/blocked-image';
                const blobScript=document.createElement('script');
                blobScript.onerror=()=>window.probe.blobScriptBlocked=true;
                blobScript.src=URL.createObjectURL(new Blob(['window.blobScriptRan=true'],{type:'application/javascript'}));
                document.body.append(blobScript);
                window.popupDenied=window.open('\(base)/blocked-popup')===null;
                </script></body></html>
                """
                let before = server.paths.count
                coordinator.install(in: view, document: csp ? ArtifactSandboxPolicy.document(html) : html)
                try await wait("WebKit load (CSP \(csp))") { !state.loading || state.error != nil }
                if let error = state.error { throw ClientError(error) }
                try await waitJS(view, label: "chart and embedded images") {
                    "window.chartReady && window.animationFrames>3 && window.animationFinished && document.getElementById('embedded').naturalWidth===28 && document.getElementById('blobImage').naturalWidth===28 && window.probe.fetchBlocked && window.probe.customFetchBlocked"
                }
                let bridge = try await view.evaluateJavaScript("window.nativeBridgePresent") as? Bool
                guard bridge == false, !view.configuration.websiteDataStore.isPersistent else { throw ClientError("Native bridge or persistent store present") }
                let networkGuard = try await view.evaluateJavaScript("window.networkGuardOK && window.frameGuardOK && window.frameGuardDelayedOK && window.popupDenied") as? Bool
                guard networkGuard == true else {
                    let diagnostic = try await view.evaluateJavaScript("JSON.stringify({direct:window.networkGuardOK,frame:window.frameGuardOK,delayed:window.frameGuardDelayedOK,popup:window.popupDenied})")
                    throw ClientError("Network API or popup escaped: \(diagnostic ?? "unknown")")
                }
                let forbiddenScripts = try await view.evaluateJavaScript("!!(window.dataScriptRan || window.blobScriptRan)") as? Bool
                // WebKit content blockers don't govern all in-memory data/blob loads;
                // the production CSP must deny those script schemes independently.
                if csp, forbiddenScripts != false { throw ClientError("Data/blob script executed despite CSP") }
                // Both native and script-triggered main-frame navigations are canceled.
                for target in ["\(base)/blocked-navigation", "pilot-artifact://library/echarts", "file:///etc/passwd", "data:text/html,escaped"] {
                    _ = try await view.evaluateJavaScript("location.href=\(jsString(target))")
                    try await Task.sleep(for: .milliseconds(150))
                    let stillHere = try await view.evaluateJavaScript("window.chartReady") as? Bool
                    guard stillHere == true else { throw ClientError("Navigation escaped: \(target)") }
                }
                let dialogDenied = try await view.evaluateJavaScript("prompt('no dialogs')===null && confirm('no dialogs')===false") as? Bool
                guard dialogDenied == true else { throw ClientError("Dialog not denied") }
                try await Task.sleep(for: .milliseconds(250))
                let requests = Array(server.paths.dropFirst(before))
                guard requests == ["/api/artifact-libraries/echarts"] else {
                    throw ClientError("Unexpected native/network requests (CSP \(csp)): \(requests)")
                }
                let png = try await state.snapshotPNG()
                guard png.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
                      let bitmap = NSBitmapImageRep(data: png), bitmap.pixelsWide >= 760,
                      bitmap.pixelsHigh >= 480 else { throw ClientError("Exported snapshot unavailable") }
                try png.write(to: directory.appending(path: csp ? "artifact-chart.png" : "artifact-blocker-only.png"))
                print("artifact-render-test passed: CSP=\(csp), ECharts, animations, library GET, data/blob SVGs, blocker, navigation, immutable RTC/WebTransport guards (main/about:blank), no bridge/popups/dialogs")
            }
            try await renderInlineDiagrams(directory: directory, client: client, server: server, base: base.absoluteString)
            try await renderImageDefaults(directory: directory, client: client)
            try await renderViewerHeader(directory: directory)
            try await renderContentGrowth(directory: directory, client: client)
            try await renderMermaidLayout(directory: directory, client: client)
            if let reactPath = ProcessInfo.processInfo.environment["PILOT_ARTIFACT_TEST_REACT"] {
                try await renderReact(htmlURL: URL(filePath: reactPath), directory: directory, client: client, server: server)
            }
            exit(0)
        } catch {
            print("artifact-render-test failed: \(error)")
            exit(1)
        }
    }

    private static func renderMermaidLayout(directory: URL, client: PilotClient) async throws {
        // A saved document without the new runtime CSS, matching the reported padded <pre> layout.
        let html = """
        <style>body{font:14px system-ui;margin:0;padding:24px}h2{font-size:20px;margin:0 0 12px}
        .mermaid{background:#fafafa;padding:16px;border-radius:12px}svg{max-width:100%}</style>
        <script src="pilot-artifact://library/mermaid"></script>
        <h2>Short catalog, detailed guidance on demand</h2>
        <pre class="mermaid">
        flowchart TD
          A[Kernel opens or resumes a session] --> B[Registers artifact with compact description]
          B --> C[artifacts namespace stays visible even at zero budget]
          C --> D[describeTool: full callable schema]
          C --> E[pilot-artifacts skill: load only when authoring]
          F[Older cached prompt lacks new skill listing] --> G[describeNamespace: bundled skill location]
          G --> E
          E --> H[tools.artifact: create or update]
          D --> H
          H --> I[Saved in session; app displays it when opened]
        </pre>
        <script>mermaid.initialize({startOnLoad:false,theme:'neutral',securityLevel:'strict'});
        mermaid.run().then(()=>window.diagramReady=true);</script>
        """
        let data = Data("""
        {"id":"centered","sessionId":"test","title":"Centered Mermaid","kind":"html","revision":1,
         "createdAt":1,"updatedAt":1,"source":\(jsString(html)),"html":\(jsString(html)),"libraries":["mermaid"]}
        """.utf8)
        let revision = try JSONDecoder().decode(ArtifactRevision.self, from: data)
        let state = ArtifactRenderState()
        let coordinator = ArtifactWebView.Coordinator(state: state)
        let view = ArtifactWebView.makeSandboxView(coordinator: coordinator,
            libraries: ArtifactLibraryHandler(libraries: [.mermaid], client: client))
        view.frame = CGRect(x: 0, y: 0, width: 1296, height: 1100)
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.orderFront(nil)
        defer { ArtifactWebView.dismantleNSView(view, coordinator: coordinator); window.close() }
        coordinator.install(in: view, document: ArtifactPreviewDocument.document(revision))
        try await waitJS(view, label: "Saved Mermaid") { "window.diagramReady === true" }
        for width in [1296, 320] {
            view.setFrameSize(CGSize(width: width, height: 1100))
            let centered = try await view.evaluateJavaScript("""
            (()=>{const p=document.querySelector('.mermaid').getBoundingClientRect();
              const s=document.querySelector('.mermaid > svg').getBoundingClientRect();
              return s.width>0 && Math.abs((s.left+s.right-p.left-p.right)/2)<1;})()
            """) as? Bool
            guard centered == true else { throw ClientError("Saved Mermaid not centered at \(width)") }
            try await state.snapshotPNG().write(to: directory.appending(path: "artifact-mermaid-centered-\(width).png"))
        }
        let overridden = try await view.evaluateJavaScript("""
        (()=>{const style=document.createElement('style');style.textContent='.mermaid > svg{margin-inline:0}';
          document.head.appendChild(style);return getComputedStyle(document.querySelector('.mermaid > svg')).marginLeft==='0px';})()
        """) as? Bool
        guard overridden == true else { throw ClientError("Mermaid author override lost") }
        print("artifact-render-test passed: saved Mermaid centered at wide/narrow widths, author override")
    }

    private static func renderContentGrowth(directory: URL, client: PilotClient) async throws {
        for (name, html) in [
            ("tall-wide", "<style>body{margin:0}</style><div id='content' style='width:1650px;height:1350px;background:#ecf7f7'>Tall and wide artifact</div>"),
            ("svg", "<style>body{margin:0}</style><svg viewBox='0 0 1650 1350' style='display:block;width:1650px;max-width:100%;height:auto'><rect width='1650' height='1350' fill='#ecf7f7'/><text x='40' y='80' font-size='32'>Natural drawing size</text></svg>"),
            ("viewport", "<style>body{margin:0;padding:16px}*{box-sizing:border-box}</style><div style='height:100vh;background:#ecf7f7'>Viewport-sized artifact</div>")
        ] {
            let state = ArtifactRenderState()
            let coordinator = ArtifactWebView.Coordinator(state: state)
            coordinator.measurementKind = .html
            let handler = ArtifactLibraryHandler(libraries: [], client: client)
            let view = ArtifactWebView.makeSandboxView(coordinator: coordinator, libraries: handler)
            view.frame = CGRect(x: 0, y: 0, width: 1200, height: 720)
            let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = view
            window.orderFront(nil)
            defer { ArtifactWebView.dismantleNSView(view, coordinator: coordinator); window.close() }
            coordinator.install(in: view, document: ArtifactSandboxPolicy.document(html))
            try await wait("Content measurement") { state.contentSize != nil }
            let size = ArtifactViewerLayout.inlineSize(availableWidth: 1800, contentSize: state.contentSize)
            view.frame.size = size
            try await Task.sleep(for: .milliseconds(1200))
            if name == "tall-wide" {
                guard size == CGSize(width: 1650, height: 1350) else { throw ClientError("Content did not grow: \(size)") }
                _ = try await view.evaluateJavaScript("document.getElementById('content').style.height='1500px'")
                try await wait("Dynamic content measurement") { state.contentSize?.height == 1500 }
                view.frame.size = ArtifactViewerLayout.inlineSize(availableWidth: 1800, contentSize: state.contentSize)
            } else if name == "svg" {
                guard size.width == 1650 else { throw ClientError("SVG did not request its natural width: \(size)") }
                try await wait("SVG height after widening") { state.contentSize?.height == 1350 }
                view.frame.size = ArtifactViewerLayout.inlineSize(availableWidth: 1800, contentSize: state.contentSize)
            } else {
                guard state.contentSize?.height == size.height, size.height < 800 else {
                    throw ClientError("Viewport sizing feedback: \(String(describing: state.contentSize))")
                }
            }
            let png = try await state.snapshotPNG()
            try png.write(to: directory.appending(path: "artifact-content-\(name).png"))
            ArtifactWebView.dismantleNSView(view, coordinator: coordinator)
            let previous = state.contentSize
            try await Task.sleep(for: .milliseconds(600))
            guard state.contentSize == previous else { throw ClientError("Offscreen measurement continued") }
            print("artifact-render-test passed: \(name), adaptive content measurement, no resize loop, teardown")
        }
    }

    private static func renderViewerHeader(directory: URL) async throws {
        let data = Data("""
        {"id":"header","sessionId":"test","title":"Release overview","kind":"swiftui","revision":1,
         "createdAt":1,"updatedAt":1,"source":"SwiftUI source","html":"<img>","libraries":[]}
        """.utf8)
        let revision = try JSONDecoder().decode(ArtifactRevision.self, from: data)
        let state = ArtifactViewState()
        state.revision = revision
        let reference = ArtifactReference(id: revision.id, sessionId: revision.sessionId, title: revision.title, revision: 1)
        let header = ArtifactViewerHeader(reference: reference, latest: false, state: state,
                                          render: ArtifactRenderState(), close: {})
        let hosting = NSHostingView(rootView: header.frame(width: 800, height: 80).background(Color(nsColor: .windowBackgroundColor)))
        hosting.frame = CGRect(x: 0, y: 0, width: 800, height: 80)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(300))
        guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { throw ClientError("Header snapshot unavailable") }
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw ClientError("Header PNG unavailable") }
        try png.write(to: directory.appending(path: "artifact-viewer-header.png"))
        print("artifact-render-test passed: actual native viewer header snapshot")
    }

    private static func renderImageDefaults(directory: URL, client: PilotClient) async throws {
        for (kind, size) in [(ArtifactKind.image, CGSize(width: 240, height: 120)),
                             (.swiftui, CGSize(width: 800, height: 600))] {
            guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width),
                                                 pixelsHigh: Int(size.height), bitsPerSample: 8, samplesPerPixel: 4,
                                                 hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                                 bytesPerRow: 0, bitsPerPixel: 0),
                  let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw ClientError("Image fixture unavailable") }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            NSColor.systemTeal.setFill()
            NSBezierPath(rect: CGRect(origin: .zero, size: size)).fill()
            NSGraphicsContext.restoreGraphicsState()
            guard let png = bitmap.representation(using: .png, properties: [:]) else { throw ClientError("Image fixture unavailable") }
            let source = "data:image/png;base64,\(png.base64EncodedString())"
            let html = "<style>body{margin:0;padding:0}img{width:100%;height:100vh;object-fit:contain}</style><img src='\(source)'>"
            let values: [String: Any] = ["id": "image", "sessionId": "test", "title": "Image", "kind": kind.rawValue,
                                       "revision": 1, "createdAt": 1, "updatedAt": 1, "source": source,
                                       "html": html, "libraries": []]
            let revision = try JSONDecoder().decode(ArtifactRevision.self, from: JSONSerialization.data(withJSONObject: values))
            let state = ArtifactRenderState()
            let coordinator = ArtifactWebView.Coordinator(state: state)
            coordinator.measurementKind = kind
            let handler = ArtifactLibraryHandler(libraries: [], client: client)
            let view = ArtifactWebView.makeSandboxView(coordinator: coordinator, libraries: handler)
            view.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
            let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = view
            window.orderFront(nil)
            defer { ArtifactWebView.dismantleNSView(view, coordinator: coordinator); window.close() }
            coordinator.install(in: view, document: ArtifactPreviewDocument.document(revision))
            try await wait("Image load") { !state.loading || state.error != nil }
            if let error = state.error { throw ClientError(error) }
            try await waitJS(view, label: "Image decode") { "document.images[0].complete && document.images[0].naturalWidth > 0" }
            for viewport in [CGSize(width: 1000, height: 700), CGSize(width: 320, height: 240)] {
                view.frame.size = viewport
                try await Task.sleep(for: .milliseconds(150))
                let dimensions = try await view.evaluateJavaScript("(() => {const b=document.images[0].getBoundingClientRect();return [b.width,b.height,b.x,b.y]})()") as? [Double]
                guard let dimensions, dimensions.count == 4 else { throw ClientError("Image dimensions unavailable") }
                let scale = min(1, viewport.width / size.width, viewport.height / size.height)
                let expected = [size.width * scale, size.height * scale,
                                (viewport.width - size.width * scale) / 2, (viewport.height - size.height * scale) / 2]
                guard zip(dimensions, expected).allSatisfy({ abs($0 - $1) < 0.5 }) else {
                    throw ClientError("\(kind) preview sizing incorrect: \(dimensions), expected \(expected)")
                }
                let screenshot = try await state.snapshotPNG()
                try screenshot.write(to: directory.appending(path: "artifact-\(kind.rawValue)-\(Int(viewport.width)).png"))
            }
            print("artifact-render-test passed: saved \(kind.rawValue), natural-size cap, proportional fit, PNG screenshot export")
        }
    }

    private static func renderInlineDiagrams(directory: URL, client: PilotClient, server: ArtifactTestServer, base: String) async throws {
        let fixtures: [(String, MarkdownDiagramKind, String, Bool)] = [
            ("svg", .svg, """
            <svg viewBox="0 0 640 320"><rect width="640" height="320" fill="#edf3ff"/>
            <text x="32" y="64" font-size="28">Inline SVG ✓</text></svg>
            """, true),
            ("svg-hostile", .svg, """
            <svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" onload="window.svgEventRan=true">
            <script>window.svgScriptRan=true;fetch('\(base)/escaped')</script>
            <image href="\(base)/escaped-image" width="100" height="100"/>
            <rect width="640" height="320" fill="#edf3ff"/>
            <text x="32" y="64" font-size="28">Scripts and external images blocked</text></svg>
            """, true),
            ("svg-invalid", .svg, "<svg><not-closed></svg>", false),
            ("svg-non-svg", .svg, "<html><script>window.breakout=true</script></html>", false),
            ("svg-doctype", .svg, "<!DOCTYPE svg><svg xmlns=\"http://www.w3.org/2000/svg\"/>", false),
            ("mermaid", .mermaid, "flowchart LR\n A[Read source] --> B[Render inline] --> C[Done ✓]", true),
            ("mermaid-sequence", .mermaid, "sequenceDiagram\n User->>Pilot: Show diagram\n Pilot-->>User: Inline preview", true),
            ("mermaid-invalid", .mermaid, "this is not a diagram", false),
            ("mermaid-config", .mermaid, """
            %%{init: {'securityLevel': 'loose', 'htmlLabels': true, 'maxEdges': 999999, 'flowchart': {'htmlLabels': true}}}%%
            graph LR
              A[Protected configuration] --> B[Safe]
              click B "\(base)/escaped-link"
            """, true),
            ("mermaid-hostile", .mermaid, """
            %%{init: {'securityLevel': 'loose', 'htmlLabels': true, 'maxEdges': 999999, 'flowchart': {'htmlLabels': true}}}%%
            graph LR
              A["</script><script>window.breakout=true</script>"] --> B[Safe]
              click B "\(base)/escaped-link"
            """, true),
        ]
        for (name, kind, source, valid) in fixtures {
            let state = ArtifactRenderState()
            let layout = InlineDiagramLayout()
            let coordinator = InlineDiagramWebView.Coordinator(state: state, layout: layout)
            let before = server.paths.count
            let view = InlineDiagramWebView.makeView(kind: kind, source: source, coordinator: coordinator, client: client)
            view.frame = CGRect(x: 0, y: 0, width: 760, height: 480)
            let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = view
            window.orderFront(nil)
            defer {
                InlineDiagramWebView.dismantleNSView(view, coordinator: coordinator)
                window.close()
            }
            try await wait("inline \(name)") { !state.loading || state.error != nil }
            guard (state.error == nil) == valid else {
                throw ClientError("Inline \(name): unexpected result \(state.error ?? "success")")
            }
            let escaped = try await view.evaluateJavaScript("!!(window.breakout || window.svgScriptRan || window.svgEventRan)") as? Bool
            guard escaped == false else { throw ClientError("Inline source executed: \(name)") }
            if valid {
                let imageLoaded = try await view.evaluateJavaScript("document.getElementById('diagram').naturalWidth > 0 && document.querySelectorAll('script').length === \(kind == .svg ? 1 : 2)") as? Bool
                guard imageLoaded == true, (60...480).contains(layout.height) else { throw ClientError("Inline image/height missing: \(name)") }
                if name == "mermaid-config" {
                    let strict = try await view.evaluateJavaScript("""
                    (() => { const c = mermaid.mermaidAPI.getConfig();
                      return c.securityLevel === 'strict' && c.htmlLabels === false &&
                        c.flowchart.htmlLabels === false && c.maxEdges === 500;
                    })()
                    """) as? Bool
                    guard strict == true else { throw ClientError("Mermaid directives changed security") }
                }
                if name == "svg" {
                    let fullHeight = layout.height
                    view.setFrameSize(CGSize(width: 320, height: 480))
                    coordinator.resize(view, width: 320)
                    try await wait("inline resize") { layout.height < fullHeight }
                    view.setFrameSize(CGSize(width: 760, height: 480))
                    coordinator.resize(view, width: 760)
                    try await wait("inline resize restoration") { layout.height >= fullHeight }
                }
                let image = try await view.takeSnapshot(configuration: nil)
                guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                      let png = bitmap.representation(using: .png, properties: [:]) else { throw ClientError("Inline snapshot unavailable") }
                try png.write(to: directory.appending(path: "inline-\(name).png"))
            }
            try await Task.sleep(for: .milliseconds(100))
            let requests = Array(server.paths.dropFirst(before))
            let allowed = kind == .mermaid ? ["/api/artifact-libraries/mermaid"] : []
            guard requests == allowed else { throw ClientError("Inline network escaped: \(name), \(requests)") }
            print("artifact-render-test passed: inline \(name), \(valid ? "image and layout" : "source fallback"), no source scripts/network")
        }
    }

    /// Optional full HTML from the backend's prepareArtifact, including its real
    /// parser-safe React bootstrap. Motion fixtures signal onAnimationComplete with
    /// window.nativeMotionDone, initialized false before mounting their component.
    private static func renderReact(htmlURL: URL, directory: URL, client: PilotClient, server: ArtifactTestServer) async throws {
        let html = try String(contentsOf: htmlURL, encoding: .utf8)
        let state = ArtifactRenderState()
        let coordinator = ArtifactWebView.Coordinator(state: state)
        // Compiled React/Motion is standalone inline JS. No library fetch is required.
        let handler = ArtifactLibraryHandler(libraries: [], client: client)
        let view = ArtifactWebView.makeSandboxView(coordinator: coordinator, libraries: handler)
        view.frame = CGRect(x: 0, y: 0, width: 760, height: 480)
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.orderFront(nil)
        defer {
            ArtifactWebView.dismantleNSView(view, coordinator: coordinator)
            window.close()
        }
        let before = server.paths.count
        coordinator.install(in: view, document: ArtifactSandboxPolicy.document(html))
        try await wait("prepared React HTML") { !state.loading || state.error != nil }
        if let error = state.error { throw ClientError(error) }
        try await waitJS(view, label: "React initial state") {
            "!!document.getElementById('artifact-root') && document.getElementById('artifact-root').textContent.includes('Native React 7')"
        }
        let hasMotionProbe = try await view.evaluateJavaScript("typeof window.nativeMotionDone !== 'undefined'") as? Bool == true
        if hasMotionProbe {
            try await waitJS(view, label: "Motion animation completion") { "window.nativeMotionDone === true" }
        }
        let hasMotionCounter = try await view.evaluateJavaScript("!!document.getElementById('native-react-counter')") as? Bool == true
        if hasMotionCounter {
            try await Task.sleep(for: .milliseconds(300))
            let visible = try await view.evaluateJavaScript("Number(getComputedStyle(document.getElementById('native-react-counter')).opacity)>=0.99") as? Bool
            guard visible == true else { throw ClientError("Motion counter did not reach opacity 1 after 300ms") }
        }
        let clicked = try await view.evaluateJavaScript("(() => {const b=document.getElementById('native-react-counter') || document.querySelector('#artifact-root button');if(!b)return false;b.click();return true;})()") as? Bool
        guard clicked == true else { throw ClientError("React fixture has no button") }
        try await waitJS(view, label: "React button state update") {
            "document.getElementById('artifact-root').textContent.includes('Native React 8')"
        }
        let guardOK = try await view.evaluateJavaScript("['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','WebTransport'].every(n=>window[n]===undefined)") as? Bool
        guard guardOK == true, server.paths.count == before else { throw ClientError("React fixture escaped network boundary") }
        let image = try await view.takeSnapshot(configuration: nil)
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { throw ClientError("React snapshot unavailable") }
        try png.write(to: directory.appending(path: "artifact-react.png"))
        print("artifact-render-test passed: prepared React bootstrap, Native React 7 → 8, \(hasMotionProbe || hasMotionCounter ? "Motion animation, " : "")zero network requests")
    }

    private static func jsString(_ value: String) -> String {
        String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
    }

    private static func wait(_ label: String, condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(15)
        while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        guard condition() else { throw ClientError("Timed out: \(label)") }
    }

    private static func waitJS(_ view: WKWebView, label: String, script: () -> String) async throws {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if (try? await view.evaluateJavaScript(script())) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        let diagnostic = try? await view.evaluateJavaScript("JSON.stringify({chart:window.chartReady,probe:window.probe,react:document.getElementById('artifact-root')?.textContent,motion:window.nativeMotionDone,images:[...document.images].map(i=>[i.src,i.naturalWidth])})")
        throw ClientError("Timed out: \(label), \(diagnostic ?? "no JS state")")
    }
}

/// Loopback-only in-process server. It records every request and serves exactly one
/// library endpoint, so unexpected resource or navigation traffic fails the test.
@MainActor
private final class ArtifactTestServer {
    private let listener: NWListener
    private let libraries: [String: Data]
    private var connections: [NWConnection] = []
    private(set) var port: UInt16?
    private(set) var paths: [String] = []

    init(library: Data, mermaid: Data) throws {
        self.libraries = ["/api/artifact-libraries/echarts": library, "/api/artifact-libraries/mermaid": mermaid]
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in if case .ready = state { self?.port = self?.listener.port?.rawValue } }
        }
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in
                guard let self else { connection.cancel(); return }
                self.connections.append(connection)
                connection.start(queue: .main)
                self.receive(connection, buffer: Data())
            }
        }
        listener.start(queue: .main)
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self else { return }
                let buffer = buffer + (data ?? Data())
                let request = String(decoding: buffer, as: UTF8.self)
                guard request.contains("\r\n\r\n") else {
                    if !complete, error == nil, buffer.count < 32768 { self.receive(connection, buffer: buffer) }
                    else { connection.cancel() }
                    return
                }
                let parts = request.components(separatedBy: "\r\n")[0].split(separator: " ")
                let path = parts.count > 1 ? String(parts[1]) : "invalid"
                self.paths.append(path)
                let allowed = parts.first == "GET" && self.libraries[path] != nil
                let body = allowed ? self.libraries[path]! : Data("denied".utf8)
                let headers = "HTTP/1.1 \(allowed ? "200 OK" : "403 Forbidden")\r\nContent-Type: application/javascript\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(headers.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }

    func stop() {
        listener.cancel()
        for connection in connections { connection.cancel() }
    }
}
