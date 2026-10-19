import AppKit
import PilotCore
import SwiftUI
import WebKit

@MainActor
final class ArtifactRenderState: ObservableObject {
    @Published var loading = true
    @Published var error: String?
    @Published var contentSize: CGSize?
    weak var webView: WKWebView?
    /// Native artifacts (visuals) draw their own screenshot instead of the web view's.
    var nativeSnapshot: (@MainActor () throws -> Data)?

    /// Longest captured side, in points. Taller or wider documents are scaled down to bound bitmap memory.
    static let maxSnapshotSide: CGFloat = 8192

    /// Capture the whole document, including content scrolled out of view and interactive state.
    /// `takeSnapshot` only paints the visible tiles, so render the full page to PDF and rasterize it.
    /// No JS/native bridge is exposed to the artifact.
    func snapshotPNG() async throws -> Data {
        if let nativeSnapshot { return try nativeSnapshot() }
        guard !loading, error == nil, let webView else { throw ClientError("Preview is not ready") }
        let pdf = try await webView.pdf(configuration: WKPDFConfiguration())
        let scale = webView.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        guard let data = Self.rasterize(pdf: pdf, scale: scale) else {
            throw ClientError("Cannot encode artifact screenshot")
        }
        return data
    }

    /// Draw the first PDF page at the display scale, capped so the longest side stays within
    /// `maxSnapshotSide` points.
    static func rasterize(pdf: Data, scale: CGFloat) -> Data? {
        guard let provider = CGDataProvider(data: pdf as CFData), let document = CGPDFDocument(provider),
              let page = document.page(at: 1) else { return nil }
        let box = page.getBoxRect(.mediaBox)
        let size = box.size
        guard size.width > 0, size.height > 0 else { return nil }
        let fit = min(1, maxSnapshotSide / max(size.width, size.height))
        let pixelsWide = max(1, Int((size.width * fit * scale).rounded()))
        let pixelsHigh = max(1, Int((size.height * fit * scale).rounded()))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: pixelsWide, height: pixelsHigh, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.scaleBy(x: CGFloat(pixelsWide) / size.width, y: CGFloat(pixelsHigh) / size.height)
        context.translateBy(x: -box.minX, y: -box.minY)
        context.drawPDFPage(page)
        guard let image = context.makeImage() else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: image)
        bitmap.size = CGSize(width: size.width * fit, height: size.height * fit)
        return bitmap.representation(using: .png, properties: [:])
    }
}

/// No message handlers, native bridge, persistent cookies, file URLs, or popup views.
/// The HTML is not loaded until WebKit has installed the fail-closed request blocker.
struct ArtifactWebView: NSViewRepresentable {
    let revision: ArtifactRevision
    let client: PilotClient
    var inline = false
    @ObservedObject var state: ArtifactRenderState
    /// Inline pages hand keyboard focus back to the chat when Escape is pressed.
    var onEscape: (() -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeNSView(context: Context) -> WKWebView {
        let libraries = ArtifactLibraryHandler(libraries: Set(revision.libraries), client: client)
        let interactive = inline && (revision.kind == .html || revision.kind == .react || revision.kind == .shader)
        let view = Self.makeSandboxView(coordinator: context.coordinator, libraries: libraries, inline: inline,
                                        interactive: interactive)
        if let page = view as? InlineArtifactWebView {
            page.onEscape = onEscape
            page.reportsHostVisibility = revision.kind == .shader
            // Clicks and typing can expand or collapse content: measure again promptly.
            page.onInteraction = { [weak coordinator = context.coordinator, weak page] in
                guard let coordinator, let page else { return }
                coordinator.startMeasuring(page)
            }
        }
        context.coordinator.measurementKind = revision.kind
        context.coordinator.awaitingMermaid = revision.libraries.contains(.mermaid)
        context.coordinator.install(in: view, document: ArtifactPreviewDocument.document(revision, inline: inline))
        return view
    }

    /// Also used by the native integration test, so it exercises the real configuration.
    static func makeSandboxView(coordinator: Coordinator, libraries: ArtifactLibraryHandler, inline: Bool = false,
                                interactive: Bool = false) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = WKUserContentController()
        configuration.userContentController.addUserScript(WKUserScript(
            source: ArtifactSandboxPolicy.networkGuard, injectionTime: .atDocumentStart,
            forMainFrameOnly: false, in: .page
        ))
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.setURLSchemeHandler(libraries, forURLScheme: "pilot-artifact")
        let view = interactive ? InlineArtifactWebView(frame: .zero, configuration: configuration)
            : WKWebView(frame: .zero, configuration: configuration)
        // Artifacts are light documents (`color-scheme: light`), so their scrollbars and form controls stay light too.
        view.appearance = NSAppearance(named: .aqua)
        if inline { view.setValue(false, forKey: "drawsBackground") }
        view.navigationDelegate = coordinator
        view.uiDelegate = coordinator
        view.allowsBackForwardNavigationGestures = false
        view.allowsLinkPreview = false
        coordinator.state.webView = view
        coordinator.libraries = libraries
        libraries.onError = { [weak coordinator] message in
            guard let coordinator, coordinator.active else { return }
            coordinator.state.error = message
            coordinator.state.loading = false
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        (view as? InlineArtifactWebView)?.onEscape = onEscape
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.active = false
        coordinator.measurementTask?.cancel()
        (view as? InlineArtifactWebView)?.tearDown()
        if coordinator.state.webView === view { coordinator.state.webView = nil }
        coordinator.libraries?.dispose()
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
        // Stop timers and scripts even if WebKit retains the old page during teardown.
        view.configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        view.loadHTMLString("", baseURL: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let state: ArtifactRenderState
        var libraries: ArtifactLibraryHandler?
        var active = true
        /// Inline diagrams wait for their asynchronous renderer after navigation finishes.
        var onLoad: ((WKWebView) -> Void)?
        var measurementKind: ArtifactKind?
        var awaitingMermaid = false
        var measurementTask: Task<Void, Never>?
        private var measurement = ArtifactContentMeasurement()
        private var initialNavigation = true
        private var document: String?
        private var restartedRenderer = false

        init(state: ArtifactRenderState) {
            self.state = state
            measurement = ArtifactContentMeasurement(retaining: state.contentSize)
        }

        func install(in view: WKWebView, document: String) {
            self.document = document
            ArtifactContentRules.load { [weak self, weak view] rule, error in
                guard let self, self.active, let view else { return }
                guard let rule else {
                    self.state.loading = false
                    self.state.error = "Cannot install artifact sandbox: \(error ?? "unknown error")"
                    return
                }
                view.configuration.userContentController.add(rule)
                view.loadHTMLString(document, baseURL: nil)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // loadHTMLString's one initial about:blank navigation is the only navigation.
            // No external schemes, downloads, subframes, same-origin daemon URLs or links.
            if initialNavigation, action.navigationType == .other, action.targetFrame?.isMainFrame == true,
               action.request.url?.absoluteString == "about:blank" {
                initialNavigation = false
                decisionHandler(.allow)
            } else { decisionHandler(.cancel) }
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.isForMainFrame && response.response.url?.absoluteString == "about:blank" ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if let onLoad { onLoad(webView) } else { state.loading = false }
            // The loaded document starts without the host's visibility flag.
            (webView as? InlineArtifactWebView)?.updateHostVisibility(force: true)
            startMeasuring(webView)
        }

        /// A single isolated-world sample, also used by native geometry regression checks.
        func readContentSize(_ view: WKWebView, kind: ArtifactKind) async throws -> CGSize? {
            let result = try await view.callAsyncJavaScript(Self.contentMeasurementScript,
                arguments: ["image": kind == .image || kind == .swiftui, "swiftui": kind == .swiftui,
                            "mermaid": awaitingMermaid],
                in: nil, contentWorld: .defaultClient) as? [Double]
            guard let result, result.count == 2 else { return nil }
            return CGSize(width: result[0], height: result[1])
        }

        /// Inspect DOM geometry in an isolated JS world. No message handler or native
        /// capability is exposed to the artifact, and offscreen renderers stop polling.
        func startMeasuring(_ view: WKWebView) {
            guard let measurementKind else { return }
            measurementTask?.cancel()
            measurementTask = Task { [weak self, weak view] in
                // Poll quickly while content settles, then slowly once it has been stable for a few
                // seconds. Asynchronous changes are still picked up, at a fraction of the JS calls.
                var previous: CGSize?
                var previousViewport: CGSize?
                var stableReads = 0
                while !Task.isCancelled {
                    guard let self, self.active, let view else { return }
                    do {
                        // Lazy rows can detach or be given a zero-sized host before dismantle.
                        // Never replace the retained row size with geometry from that transition.
                        let viewport = view.bounds.size
                        guard view.window != nil, viewport.width > 0, viewport.height > 0 else {
                            try await Task.sleep(for: .milliseconds(500))
                            continue
                        }
                        let intrinsic = measurementKind == .image || measurementKind == .swiftui
                        let result = try await self.readContentSize(view, kind: measurementKind)
                        guard self.active, !Task.isCancelled else { return }
                        guard view.window != nil, view.bounds.size == viewport else {
                            try await Task.sleep(for: .milliseconds(500))
                            continue
                        }
                        if result == previous, viewport == previousViewport { stableReads += 1 } else { stableReads = 0 }
                        previous = result
                        previousViewport = viewport
                        if let result,
                           let size = self.measurement.record(content: result, viewport: viewport, intrinsicImage: intrinsic),
                           self.state.contentSize != size {
                            self.state.contentSize = size
                        }
                    } catch {
                        // Measurement is best-effort and must not replace a working preview with an error.
                    }
                    do { try await Task.sleep(for: .milliseconds(stableReads >= 6 ? 2000 : 500)) } catch { return }
                }
            }
        }

        private static let contentMeasurementScript = """
            if (image) {
              const img = document.images[0];
              if (!img || !img.naturalWidth || !img.naturalHeight) return null;
              const scale = swiftui ? (img.dataset.pilotScale === '2' ? 0.5 :
                Math.min(1, 800 / img.naturalWidth, 600 / img.naturalHeight)) : 1;
              return [img.naturalWidth * scale, img.naturalHeight * scale];
            }
            const body = document.body, root = document.documentElement;
            if (!body || !root) return null;
            // A slow Mermaid render can leave its short source visible for several
            // polls. It is not the saved diagram's geometry, however stable it looks.
            if (mermaid && Array.from(document.querySelectorAll('.mermaid')).slice(0, 128)
              .some(node => !node.querySelector('svg'))) return null;
            let width = Math.max(body.scrollWidth, root.scrollWidth);
            const css = getComputedStyle(body);
            // document scrollHeight is at least the viewport height, so it cannot
            // shrink a short inline card. The sandbox uses standards mode, where
            // the body's own scrollHeight includes visible flow overflow and respects
            // nested scroll/clip containers. A Range over the body does NOT respect
            // those clips: expanding or scrolling a tree would resize the whole card.
            const bounds = body.getBoundingClientRect();
            const paddingX = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
            const paddingBottom = parseFloat(css.paddingBottom);
            let height = Math.max(1,
              bounds.bottom + scrollY + parseFloat(css.marginBottom),
              bounds.top + scrollY + body.scrollHeight + parseFloat(css.borderTopWidth) + parseFloat(css.marginBottom));
            let preferredWidth = width;
            // Body scrollHeight misses positioned descendants whose containing block
            // is outside body. Inspect only unclipped branches, with a hard work bound.
            // Treat SVGs as leaves: their paths do not request host space. This also
            // keeps icons inside a scrolling tree out of the natural SVG size request.
            let node = body.firstElementChild, visited = 0;
            while (node && visited++ < 4096) {
              const style = getComputedStyle(node);
              const svg = node instanceof SVGSVGElement;
              const hidden = style.display === 'none';
              if (!hidden) {
                if (style.position === 'absolute' || style.position === 'fixed' || svg) {
                  const rect = node.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    height = Math.max(height, rect.bottom + scrollY + paddingBottom);
                    // Preserve a responsive drawing's natural width, fitting its height.
                    const box = svg ? node.viewBox.baseVal : null;
                    if (box && box.width > rect.width && box.height > 0) {
                      preferredWidth = Math.max(preferredWidth, box.width + paddingX);
                      height = Math.max(height, rect.top + scrollY + box.height *
                        Math.min(1, Math.max(0, innerWidth - paddingX) / box.width) + paddingBottom);
                    }
                  }
                }
              }
              const clips = style.overflowY !== 'visible' ||
                style.contain.split(' ').some(value => ['paint', 'strict', 'content'].includes(value));
              if (!hidden && !svg && !clips && node.firstElementChild) {
                node = node.firstElementChild;
              } else {
                while (node !== body && !node.nextElementSibling) node = node.parentElement;
                node = node === body ? null : node.nextElementSibling;
              }
            }
            return [preferredWidth, height];
            """
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // WebKit can reclaim a background renderer under memory pressure. Reload the same isolated
            // document once; a page that keeps crashing its renderer shows the error instead of looping.
            if active, !restartedRenderer, let document {
                restartedRenderer = true
                measurementTask?.cancel()
                measurement = ArtifactContentMeasurement(retaining: state.contentSize)
                initialNavigation = true
                state.error = nil
                state.loading = true
                webView.loadHTMLString(document, baseURL: nil)
                return
            }
            state.loading = false
            state.error = "Artifact renderer stopped. Close and reopen the preview to retry."
        }
        private func fail(_ error: Error) {
            guard active, (error as NSError).code != NSURLErrorCancelled else { return }
            state.loading = false
            state.error = error.localizedDescription
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) { completionHandler(nil) }
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) { completionHandler() }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) { completionHandler(false) }
        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) { completionHandler(nil) }
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
    }
}

/// One compiled content blocker shared by every artifact view, instead of a compile per view.
@MainActor
enum ArtifactContentRules {
    private static var rule: WKContentRuleList?
    private static var waiters: [(WKContentRuleList?, String?) -> Void] = []

    static func load(_ completion: @escaping (WKContentRuleList?, String?) -> Void) {
        if let rule { return completion(rule, nil) }
        waiters.append(completion)
        guard waiters.count == 1 else { return }
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "pilot-artifact-deny-network-v1", encodedContentRuleList: ArtifactSandboxPolicy.contentRules
        ) { rule, error in
            let message = error?.localizedDescription
            Task { @MainActor in
                // A failure is not cached, so the next view retries the compile.
                if let rule, message == nil { Self.rule = rule }
                let pending = waiters
                waiters = []
                for waiter in pending { waiter(message == nil ? rule : nil, message) }
            }
        }
    }
}

/// Library bundles are megabytes (Mermaid is about 5 MB) and identical for every view. Keep one copy per
/// daemon endpoint, revalidate it with the daemon's ETag, and coalesce concurrent loads. If pilotd is
/// briefly unreachable (for example while restarting), an already-loaded bundle remains usable.
@MainActor
final class ArtifactLibraryCache {
    static let shared = ArtifactLibraryCache()
    static let maxBytes = 12 * 1024 * 1024
    /// Rows scrolling in and out reuse a recently validated bundle without another request.
    private static let freshness: TimeInterval = 30

    private struct Entry {
        let data: Data
        let etag: String?
        let validated: Date
    }

    private struct Key: Hashable { let owner: HostRef?; let endpoint: URL }
    private var entries: [Key: Entry] = [:]
    private var inflight: [Key: Task<Data, Error>] = [:]
    private let redirects = RejectArtifactRedirects()
    private lazy var session = URLSession(configuration: .ephemeral, delegate: redirects, delegateQueue: nil)

    func data(for endpoint: URL, owner: HostRef? = nil) async throws -> Data {
        let key = Key(owner: owner, endpoint: endpoint)
        if let entry = entries[key], Date().timeIntervalSince(entry.validated) < Self.freshness { return entry.data }
        if let task = inflight[key] { return try await task.value }
        guard inflight.count < 4 else { throw ClientError("Artifact library reads are busy") }
        let cached = entries[key]
        let session = session
        let task = Task<Data, Error> { @MainActor in
            defer { self.inflight[key] = nil }
            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 20
            if let etag = cached?.etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
            do {
                let (data, response) = try await BoundedHTTPData.read(request, maximumBytes: Self.maxBytes, configuration: session.configuration)
                let http = response
                guard response.url == endpoint else {
                    throw ClientError("Artifact library unavailable")
                }
                if http.statusCode == 304, let cached {
                    self.entries[key] = Entry(data: cached.data, etag: cached.etag, validated: Date())
                    return cached.data
                }
                guard http.statusCode == 200, data.count <= Self.maxBytes else { throw ClientError("Artifact library unavailable") }
                self.entries[key] = Entry(data: data, etag: http.value(forHTTPHeaderField: "ETag"), validated: Date())
                while self.entries.count > 16 || self.entries.values.reduce(0, { $0 + $1.data.count }) > 48 * 1024 * 1024 {
                    guard let evicted = self.entries.keys.first else { break }
                    self.entries[evicted] = nil
                }
                return data
            } catch {
                if let cached { return cached.data }
                throw error
            }
        }
        inflight[key] = task
        return try await task.value
    }
}

/// This is a read-only resource provider, not an RPC channel. Only canonical GETs for
/// a declared, fixed library can cause a native HTTP request. Redirects are forbidden.
@MainActor
final class ArtifactLibraryHandler: NSObject, WKURLSchemeHandler {
    var onError: ((String) -> Void)?
    private let libraries: Set<ArtifactLibrary>
    private let client: PilotClient
    private var pending: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(libraries: Set<ArtifactLibrary>, client: PilotClient) {
        self.libraries = libraries
        self.client = client
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, urlSchemeTask.request.httpMethod == "GET",
              let library = ArtifactSandboxPolicy.library(for: url), libraries.contains(library) else {
            urlSchemeTask.didFailWithError(ClientError("Artifact resource denied"))
            return
        }
        let key = ObjectIdentifier(urlSchemeTask)
        pending[key] = Task { [weak self] in
            guard let self else { return }
            do {
                let endpoint = try self.client.artifactLibraryURL(library)
                let data = try await ArtifactLibraryCache.shared.data(for: endpoint, owner: self.client.hostIdentity)
                guard !Task.isCancelled, self.pending[key] != nil else { return }
                urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "application/javascript", expectedContentLength: data.count,
                                                    textEncodingName: "utf-8"))
                urlSchemeTask.didReceive(data)
                urlSchemeTask.didFinish()
            } catch {
                if !Task.isCancelled, self.pending[key] != nil {
                    self.onError?("Cannot load \(library.rawValue): \(error.localizedDescription)")
                    urlSchemeTask.didFailWithError(error)
                }
            }
            self.pending[key] = nil
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        pending.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }

    func dispose() {
        for task in pending.values { task.cancel() }
        pending.removeAll()
    }
}

private final class RejectArtifactRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
