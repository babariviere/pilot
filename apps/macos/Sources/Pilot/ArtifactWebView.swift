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

    /// Capture the current viewport, including interactive state, without a JS/native bridge.
    func snapshotPNG() async throws -> Data {
        guard !loading, error == nil, let webView else { throw ClientError("Preview is not ready") }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = webView.bounds
        let image = try await webView.takeSnapshot(configuration: configuration)
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let data = bitmap.representation(using: .png, properties: [:]) else {
            throw ClientError("Cannot encode artifact screenshot")
        }
        return data
    }
}

/// No message handlers, native bridge, persistent cookies, file URLs, or popup views.
/// The HTML is not loaded until WebKit has installed the fail-closed request blocker.
struct ArtifactWebView: NSViewRepresentable {
    let revision: ArtifactRevision
    @ObservedObject var state: ArtifactRenderState

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeNSView(context: Context) -> WKWebView {
        let libraries = ArtifactLibraryHandler(libraries: Set(revision.libraries), client: AppModel.shared.client)
        let view = Self.makeSandboxView(coordinator: context.coordinator, libraries: libraries)
        context.coordinator.measurementKind = revision.kind
        context.coordinator.install(in: view, document: ArtifactPreviewDocument.document(revision))
        return view
    }

    /// Also used by the native integration test, so it exercises the real configuration.
    static func makeSandboxView(coordinator: Coordinator, libraries: ArtifactLibraryHandler) -> WKWebView {
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
        let view = WKWebView(frame: .zero, configuration: configuration)
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

    func updateNSView(_ view: WKWebView, context: Context) {}

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.active = false
        coordinator.measurementTask?.cancel()
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
        var measurementTask: Task<Void, Never>?
        private var measurement = ArtifactContentMeasurement()
        private var initialNavigation = true
        private var document: String?
        private var restartedRenderer = false

        init(state: ArtifactRenderState) { self.state = state }

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
            startMeasuring(webView)
        }

        /// Inspect DOM geometry in an isolated JS world. No message handler or native
        /// capability is exposed to the artifact, and offscreen renderers stop polling.
        func startMeasuring(_ view: WKWebView) {
            guard let measurementKind else { return }
            measurementTask?.cancel()
            measurementTask = Task { [weak self, weak view] in
                // Poll quickly while content settles, then slowly once it has been stable for a few
                // seconds. Asynchronous changes are still picked up, at a fraction of the JS calls.
                var previous: [Double]?
                var previousViewport: CGSize?
                var stableReads = 0
                while !Task.isCancelled {
                    guard let self, self.active, let view else { return }
                    do {
                        let intrinsic = measurementKind == .image || measurementKind == .swiftui
                        let result = try await view.callAsyncJavaScript("""
                        if (image) {
                          const img = document.images[0];
                          if (!img || !img.naturalWidth || !img.naturalHeight) return null;
                          const scale = swiftui ? Math.min(1, 800 / img.naturalWidth, 600 / img.naturalHeight) : 1;
                          return [img.naturalWidth * scale, img.naturalHeight * scale];
                        }
                        const body = document.body, root = document.documentElement;
                        if (!body || !root) return null;
                        let width = Math.max(body.scrollWidth, root.scrollWidth);
                        let height = Math.max(body.scrollHeight, root.scrollHeight);
                        const css = getComputedStyle(body);
                        const paddingX = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
                        const paddingBottom = parseFloat(css.paddingBottom);
                        let preferredWidth = width, preferredHeight = height;
                        // Mermaid and inline SVGs often shrink to max-width:100%. Preserve their
                        // natural drawing size as a width request, with a height fitted to this viewport.
                        for (const svg of Array.from(document.querySelectorAll('svg')).slice(0, 128)) {
                          const bounds = svg.getBoundingClientRect();
                          const box = svg.viewBox.baseVal;
                          if (bounds.width <= 0 || bounds.height <= 0 || box.width <= bounds.width || box.height <= 0) continue;
                          preferredWidth = Math.max(preferredWidth, box.width + paddingX);
                          preferredHeight = Math.max(preferredHeight, bounds.top + scrollY +
                            box.height * Math.min(1, Math.max(0, innerWidth - paddingX) / box.width) + paddingBottom);
                        }
                        return [preferredWidth, preferredHeight];
                        """, arguments: ["image": intrinsic, "swiftui": measurementKind == .swiftui],
                            in: nil, contentWorld: .defaultClient) as? [Double]
                        guard self.active, !Task.isCancelled else { return }
                        if result == previous, view.bounds.size == previousViewport { stableReads += 1 } else { stableReads = 0 }
                        previous = result
                        previousViewport = view.bounds.size
                        if let result, result.count == 2,
                           let size = self.measurement.record(content: CGSize(width: result[0], height: result[1]),
                                                              viewport: view.bounds.size, intrinsicImage: intrinsic),
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
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // WebKit can reclaim a background renderer under memory pressure. Reload the same isolated
            // document once; a page that keeps crashing its renderer shows the error instead of looping.
            if active, !restartedRenderer, let document {
                restartedRenderer = true
                measurementTask?.cancel()
                measurement = ArtifactContentMeasurement()
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

    private var entries: [URL: Entry] = [:]
    private var inflight: [URL: Task<Data, Error>] = [:]
    private let redirects = RejectArtifactRedirects()
    private lazy var session = URLSession(configuration: .ephemeral, delegate: redirects, delegateQueue: nil)

    func data(for endpoint: URL) async throws -> Data {
        if let entry = entries[endpoint], Date().timeIntervalSince(entry.validated) < Self.freshness { return entry.data }
        if let task = inflight[endpoint] { return try await task.value }
        let cached = entries[endpoint]
        let session = session
        let task = Task<Data, Error> { @MainActor in
            defer { self.inflight[endpoint] = nil }
            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 20
            if let etag = cached?.etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, response.url == endpoint else {
                    throw ClientError("Artifact library unavailable")
                }
                if http.statusCode == 304, let cached {
                    self.entries[endpoint] = Entry(data: cached.data, etag: cached.etag, validated: Date())
                    return cached.data
                }
                guard http.statusCode == 200, data.count <= Self.maxBytes else { throw ClientError("Artifact library unavailable") }
                self.entries[endpoint] = Entry(data: data, etag: http.value(forHTTPHeaderField: "ETag"), validated: Date())
                return data
            } catch {
                if let cached { return cached.data }
                throw error
            }
        }
        inflight[endpoint] = task
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
                let data = try await ArtifactLibraryCache.shared.data(for: endpoint)
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
