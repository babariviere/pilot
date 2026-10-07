import AppKit
import Network
import PilotCore
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
            let server = try ArtifactTestServer(library: library)
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
                let image = try await view.takeSnapshot(configuration: nil)
                guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                      let png = bitmap.representation(using: .png, properties: [:]) else { throw ClientError("Snapshot unavailable") }
                try png.write(to: directory.appending(path: csp ? "artifact-chart.png" : "artifact-blocker-only.png"))
                print("artifact-render-test passed: CSP=\(csp), ECharts, animations, library GET, data/blob SVGs, blocker, navigation, immutable RTC/WebTransport guards (main/about:blank), no bridge/popups/dialogs")
            }
            if let reactPath = ProcessInfo.processInfo.environment["PILOT_ARTIFACT_TEST_REACT"] {
                try await renderReact(htmlURL: URL(filePath: reactPath), directory: directory, client: client, server: server)
            }
            exit(0)
        } catch {
            print("artifact-render-test failed: \(error)")
            exit(1)
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
    private let library: Data
    private var connections: [NWConnection] = []
    private(set) var port: UInt16?
    private(set) var paths: [String] = []

    init(library: Data) throws {
        self.library = library
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
                let allowed = parts.first == "GET" && path == "/api/artifact-libraries/echarts"
                let body = allowed ? self.library : Data("denied".utf8)
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
