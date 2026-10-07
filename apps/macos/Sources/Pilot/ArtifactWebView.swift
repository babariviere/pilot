import AppKit
import PilotCore
import SwiftUI
import WebKit

@MainActor
final class ArtifactRenderState: ObservableObject {
    @Published var loading = true
    @Published var error: String?
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
        context.coordinator.install(in: view, document: ArtifactSandboxPolicy.document(revision.html))
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
        private var initialNavigation = true

        init(state: ArtifactRenderState) { self.state = state }

        func install(in view: WKWebView, document: String) {
            WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "pilot-artifact-deny-network-v1", encodedContentRuleList: ArtifactSandboxPolicy.contentRules
            ) { [weak self, weak view] rule, error in
                Task { @MainActor in
                    guard let self, self.active, let view else { return }
                    guard let rule, error == nil else {
                        self.state.loading = false
                        self.state.error = "Cannot install artifact sandbox: \(error?.localizedDescription ?? "unknown error")"
                        return
                    }
                    view.configuration.userContentController.add(rule)
                    view.loadHTMLString(document, baseURL: nil)
                }
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

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { state.loading = false }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
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

/// This is a read-only resource provider, not an RPC channel. Only canonical GETs for
/// a declared, fixed library can cause a native HTTP request. Redirects are forbidden.
@MainActor
final class ArtifactLibraryHandler: NSObject, WKURLSchemeHandler {
    var onError: ((String) -> Void)?
    private let libraries: Set<ArtifactLibrary>
    private let client: PilotClient
    private var pending: [ObjectIdentifier: Task<Void, Never>] = [:]
    private let redirects = RejectArtifactRedirects()
    private lazy var session = URLSession(configuration: .ephemeral, delegate: redirects, delegateQueue: nil)

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
                var request = URLRequest(url: endpoint)
                request.timeoutInterval = 20
                let (data, response) = try await self.session.data(for: request)
                guard !Task.isCancelled, self.pending[key] != nil else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200, response.url == endpoint,
                      data.count <= 12 * 1024 * 1024 else { throw ClientError("Artifact library unavailable") }
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
        session.invalidateAndCancel()
    }
}

private final class RejectArtifactRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
