import AppKit
import PilotCore
import SwiftUI
import WebKit

@MainActor
final class InlineDiagramViewState: ObservableObject {
    @Published var source = false
    @Published var visible = false
}

/// Like artifact cards, offscreen chat blocks release their WebKit process and library tasks.
struct InlineDiagramBlock: View {
    let kind: MarkdownDiagramKind
    let text: String
    @StateObject private var state = InlineDiagramViewState()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(kind.rawValue).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(state.source ? "Preview" : "Source") { state.source.toggle() }
                    .buttonStyle(.borderless).font(.caption)
                CopyButton(text: text)
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Theme.subtleFill)
            if state.source {
                CodeBlock(language: kind.rawValue, text: text)
            } else if state.visible {
                InlineDiagramPreview(kind: kind, text: text)
            } else {
                Color.clear.frame(height: 180)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline))
        .onAppear { state.visible = true }
        .onDisappear { state.visible = false }
    }
}

@MainActor
final class InlineDiagramLayout: ObservableObject {
    @Published var height: CGFloat = 180

    func update(_ value: Double) {
        guard value.isFinite else { return }
        let height = min(480, max(60, ceil(value)))
        if abs(self.height - height) > 1 { self.height = height }
    }
}

private struct InlineDiagramPreview: View {
    let kind: MarkdownDiagramKind
    let text: String
    @StateObject private var render = ArtifactRenderState()
    @StateObject private var layout = InlineDiagramLayout()

    var body: some View {
        if let error = render.error {
            VStack(alignment: .leading, spacing: 8) {
                Text("Could not render \(kind.rawValue): \(error)")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 10)
                CodeBlock(language: kind.rawValue, text: text)
            }.padding(.top, 8)
        } else {
            GeometryReader { geometry in
                InlineDiagramWebView(kind: kind, source: text, width: geometry.size.width,
                                     state: render, layout: layout)
                    .overlay { if render.loading { ProgressView("Rendering diagram…") } }
            }
            .frame(height: layout.height)
        }
    }
}

/// Only trusted bootstrap/library JavaScript runs. Diagram source is inert data, not HTML.
struct InlineDiagramWebView: NSViewRepresentable {
    let kind: MarkdownDiagramKind
    let source: String
    let width: CGFloat
    @ObservedObject var state: ArtifactRenderState
    @ObservedObject var layout: InlineDiagramLayout

    func makeCoordinator() -> Coordinator { Coordinator(state: state, layout: layout) }

    func makeNSView(context: Context) -> WKWebView {
        Self.makeView(kind: kind, source: source, coordinator: context.coordinator, client: AppModel.shared.client)
    }

    /// Shared with the native renderer integration test.
    static func makeView(kind: MarkdownDiagramKind, source: String, coordinator: Coordinator, client: PilotClient) -> WKWebView {
        let libraries = ArtifactLibraryHandler(libraries: kind == .mermaid ? [.mermaid] : [], client: client)
        let view = ArtifactWebView.makeSandboxView(coordinator: coordinator.sandbox, libraries: libraries)
        coordinator.sandbox.onLoad = { [weak coordinator] view in coordinator?.render(view) }
        coordinator.sandbox.install(in: view, document: InlineDiagramDocument.document(kind: kind, source: source))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        // MarkdownView keys the whole block by kind and source, so only layout changes reuse this page.
        context.coordinator.resize(view, width: width)
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.renderTask?.cancel()
        coordinator.resizeTask?.cancel()
        coordinator.sandbox.onLoad = nil
        ArtifactWebView.dismantleNSView(view, coordinator: coordinator.sandbox)
    }

    @MainActor
    final class Coordinator {
        let sandbox: ArtifactWebView.Coordinator
        let layout: InlineDiagramLayout
        var renderTask: Task<Void, Never>?
        var resizeTask: Task<Void, Never>?
        private var width: CGFloat = 0

        init(state: ArtifactRenderState, layout: InlineDiagramLayout) {
            sandbox = ArtifactWebView.Coordinator(state: state)
            self.layout = layout
        }

        func render(_ view: WKWebView) {
            renderTask = Task { [weak self, weak view] in
                guard let self, let view else { return }
                do {
                    let result = try await view.callAsyncJavaScript("""
                    let timer;
                    try {
                      return await Promise.race([
                        window.pilotDiagramReady,
                        new Promise(resolve => { timer = setTimeout(() => resolve({error:'Rendering timed out'}), 15000); })
                      ]);
                    } finally { clearTimeout(timer); }
                    """, arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
                    guard self.sandbox.active, !Task.isCancelled else { return }
                    if let error = result?["error"] as? String {
                        self.sandbox.state.error = error
                    } else if let height = result?["height"] as? Double {
                        self.layout.update(height)
                    } else {
                        self.sandbox.state.error = "Renderer returned no diagram"
                    }
                    self.sandbox.state.loading = false
                } catch { self.fail(error) }
            }
        }

        func resize(_ view: WKWebView, width: CGFloat) {
            guard abs(self.width - width) > 1 else { return }
            self.width = width
            guard !sandbox.state.loading, sandbox.state.error == nil else { return }
            resizeTask?.cancel()
            resizeTask = Task { [weak self, weak view] in
                guard let self, let view else { return }
                do {
                    let height = try await view.callAsyncJavaScript("""
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    return window.pilotDiagramHeight();
                    """, arguments: [:], in: nil, contentWorld: .page) as? Double
                    guard self.sandbox.active, !Task.isCancelled, let height else { return }
                    self.layout.update(height)
                } catch { self.fail(error) }
            }
        }

        private func fail(_ error: Error) {
            guard sandbox.active, !Task.isCancelled else { return }
            sandbox.state.error = error.localizedDescription
            sandbox.state.loading = false
        }
    }
}
