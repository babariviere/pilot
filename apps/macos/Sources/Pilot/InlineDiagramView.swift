import AppKit
import MermaidRender
import PilotCore
import SwiftUI
import WebKit

@MainActor
final class InlineDiagramViewState: ObservableObject {
    @Published var source = false
    @Published var visible = false
    @Published var viewer = false
    /// The native renderer could not draw this diagram; use the web renderer instead.
    @Published var nativeFailed = false
}

/// Mermaid the native renderer accepted draws natively; other diagrams use an isolated WebKit page.
/// Like artifact cards, offscreen chat blocks release their bitmaps, WebKit process and library tasks.
struct InlineDiagramBlock: View {
    let kind: MarkdownDiagramKind
    let text: String
    var native: NativeMermaidLayout? = nil
    @StateObject private var state = InlineDiagramViewState()

    private var nativeLayout: NativeMermaidLayout? { state.nativeFailed ? nil : native }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.source {
                CodeBlock(language: kind.rawValue, text: text)
            } else if let nativeLayout {
                NativeDiagramPreview(layout: nativeLayout, source: text, visible: state.visible,
                                     failed: { state.nativeFailed = true }, onOpen: { state.viewer = true })
            } else if state.visible {
                InlineDiagramPreview(kind: kind, text: text, onOpen: { state.viewer = true })
            } else {
                // Reserve the last measured height so rows do not jump as they scroll back in.
                Color.clear.frame(height: InlineDiagramLayout.cachedHeight(kind: kind, source: text) ?? 180)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
        .contextMenu {
            Button("Expand diagram") { state.viewer = true }
            Button(state.source ? "Show preview" : "Show source") { state.source.toggle() }
            Button("Copy source") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        }
        .onAppear { state.visible = true }
        .onDisappear { state.visible = false }
        .sheet(isPresented: $state.viewer) {
            if let nativeLayout {
                NativeDiagramViewer(kind: kind, text: text, layout: nativeLayout)
            } else {
                InlineDiagramViewer(kind: kind, text: text)
            }
        }
    }
}

/// Sizes a native diagram block from the drawing's natural size before anything is drawn: the column
/// width, the height from `DiagramLayout`, and the drawing centered at its fitted (shrink-only) size.
struct NativeDiagramFrame: Layout {
    let natural: CGSize

    private func width(_ proposal: ProposedViewSize) -> CGFloat {
        guard let width = proposal.width, width.isFinite else { return Theme.column }
        return max(0, width)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = width(proposal)
        return CGSize(width: width, height: DiagramLayout.inlineHeight(natural: natural, availableWidth: width)
            ?? DiagramLayout.inlineMinHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let drawing = DiagramLayout.inlineDrawingSize(natural: natural, availableWidth: bounds.width) ?? .zero
        for subview in subviews {
            subview.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center, proposal: ProposedViewSize(drawing))
        }
    }
}

/// A bitmap drawn off the main actor at the block's pixel size. While the window resizes, the previous
/// bitmap scales with the block and one new one is drawn after the size settles.
private struct NativeDiagramPreview: View {
    let layout: NativeMermaidLayout
    let source: String
    let visible: Bool
    let failed: () -> Void
    let onOpen: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @State private var image: CGImage?

    var body: some View {
        NativeDiagramFrame(natural: layout.natural) {
            GeometryReader { geometry in
                let key = imageKey(geometry.size)
                Group {
                    if let shown = image ?? key.flatMap(NativeMermaid.cachedImage) {
                        Image(decorative: shown, scale: displayScale).resizable().interpolation(.high)
                    } else {
                        Color.clear
                    }
                }
                .task(id: visible ? key : nil) { await draw(key) }
            }
            .accessibilityElement()
            .accessibilityLabel(layout.altText)
            .accessibilityAddTraits(.isImage)
        }
        .overlay {
            EmbeddedPreviewButton(title: "Expand mermaid diagram", help: "Click to expand diagram", open: onOpen)
        }
        .onChange(of: visible) { _, visible in
            if !visible { image = nil }
        }
    }

    private func imageKey(_ size: CGSize) -> NativeMermaid.ImageKey? {
        let width = Int((size.width * displayScale).rounded()), height = Int((size.height * displayScale).rounded())
        guard width > 0, height > 0 else { return nil }
        return NativeMermaid.ImageKey(source: source, dark: colorScheme == .dark, width: width, height: height)
    }

    private func draw(_ key: NativeMermaid.ImageKey?) async {
        guard visible, let key else { return }
        if let cached = NativeMermaid.cachedImage(key) {
            image = cached
            return
        }
        if image != nil { try? await Task.sleep(for: .milliseconds(150)) }
        guard !Task.isCancelled else { return }
        let drawn = await NativeMermaid.image(layout, key: key)
        guard !Task.isCancelled else { return }
        if let drawn { image = drawn } else { failed() }
    }
}

/// The expanded viewer opens the vector drawing at its natural size, shrunk to fit and centered;
/// pinch or scroll-zoom to enlarge it.
struct NativeDiagramViewer: View {
    let kind: MarkdownDiagramKind
    let text: String
    let layout: NativeMermaidLayout
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var state = InlineDiagramViewState()

    var body: some View {
        let size = ArtifactViewerLayout.size(available: NSApp.keyWindow?.screen?.visibleFrame.size
            ?? NSScreen.main?.visibleFrame.size ?? CGSize(width: 1440, height: 900), contentSize: layout.natural)
        VStack(spacing: 0) {
            HStack {
                Text("\(kind.rawValue.uppercased()) diagram").font(.pilot(.headline, weight: .semibold))
                Spacer()
                Button(state.source ? "Preview" : "Source") { state.source.toggle() }
                CopyButton(text: text)
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(14)
            Divider()
            if state.source {
                ScrollView { CodeBlock(language: kind.rawValue, text: text) }
            } else {
                ZoomableDiagramView(layout: layout, dark: colorScheme == .dark)
            }
        }
        .frame(width: size.width, height: size.height)
        .background(Theme.background)
    }
}

private struct ZoomableDiagramView: NSViewRepresentable {
    let layout: NativeMermaidLayout
    let dark: Bool

    final class Coordinator { var dark: Bool? }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> FittingDiagramScrollView {
        let scroll = FittingDiagramScrollView(natural: layout.natural)
        let imageView = NSImageView(frame: CGRect(origin: .zero, size: layout.natural))
        imageView.imageScaling = .scaleAxesIndependently
        imageView.setAccessibilityLabel(layout.altText)
        scroll.documentView = imageView
        return scroll
    }

    func updateNSView(_ scroll: FittingDiagramScrollView, context: Context) {
        guard context.coordinator.dark != dark else { return }
        context.coordinator.dark = dark
        (scroll.documentView as? NSImageView)?.image = MermaidRenderer.image(diagram: layout.diagram,
                                                                            theme: NativeMermaid.theme(dark: dark))
    }
}

/// Magnifies a natural-size drawing: fits it once on first layout (never above 100%), keeps it
/// centered when smaller than the view, and allows pinch zoom up to 8×.
final class FittingDiagramScrollView: NSScrollView {
    private let natural: CGSize
    private var fitted = false

    init(natural: CGSize) {
        self.natural = natural
        super.init(frame: .zero)
        contentView = CenteringClipView()
        drawsBackground = false
        hasVerticalScroller = true
        hasHorizontalScroller = true
        autohidesScrollers = true
        allowsMagnification = true
        minMagnification = 0.1
        maxMagnification = 8
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        guard !fitted, bounds.width > 0, bounds.height > 0,
              let fit = DiagramLayout.fit(natural, within: CGSize(width: bounds.width - 2 * DiagramLayout.padding,
                                                                  height: bounds.height - 2 * DiagramLayout.padding))
        else { return }
        fitted = true
        magnification = max(minMagnification, fit.width / natural.width)
    }
}

/// Centers a document smaller than the visible area instead of pinning it to the corner.
final class CenteringClipView: NSClipView {
    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var rect = super.constrainBoundsRect(proposedBounds)
        guard let document = documentView else { return rect }
        if rect.width > document.frame.width { rect.origin.x = (document.frame.width - rect.width) / 2 }
        if rect.height > document.frame.height { rect.origin.y = (document.frame.height - rect.height) / 2 }
        return rect
    }
}

@MainActor
final class InlineDiagramLayout: ObservableObject {
    @Published var height: CGFloat = 180
    private let key: String?
    /// The drawing's intrinsic size, once rendered. With it, width changes resize the row in Swift.
    private(set) var natural: CGSize?
    private(set) var width: CGFloat = 0
    private static var heights: [String: CGFloat] = [:]
    private static let limit = 512

    init(kind: MarkdownDiagramKind? = nil, source: String? = nil) {
        key = kind.flatMap { kind in source.map { Self.key(kind: kind, source: $0) } }
        if let key, let height = Self.heights[key] { self.height = height }
    }

    static func cachedHeight(kind: MarkdownDiagramKind, source: String) -> CGFloat? {
        heights[key(kind: kind, source: source)]
    }

    private static func key(kind: MarkdownDiagramKind, source: String) -> String { kind.rawValue + ":" + source }

    /// A page measurement, used when the drawing has no usable natural size.
    func update(_ value: Double) {
        guard let height = DiagramLayout.inlineHeight(measured: CGFloat(value)) else { return }
        apply(height)
    }

    /// Size the block from the drawing's natural size: shrink to the column and the inline
    /// ceiling, keeping its aspect ratio, never enlarge (the page applies the same rule).
    func update(natural: CGSize, width: CGFloat) {
        self.natural = natural
        resize(width: width)
    }

    /// Returns false when only a page measurement can size this block.
    @discardableResult
    func resize(width: CGFloat) -> Bool {
        if width.isFinite, width > 0 { self.width = width }
        guard let natural, let height = DiagramLayout.inlineHeight(natural: natural, availableWidth: self.width) else { return false }
        apply(height)
        return true
    }

    private func apply(_ height: CGFloat) {
        if abs(self.height - height) > 1 { self.height = height }
        if let key {
            if Self.heights.count >= Self.limit, Self.heights[key] == nil { Self.heights.removeAll(keepingCapacity: true) }
            Self.heights[key] = self.height
        }
    }
}

struct InlineDiagramViewer: View {
    let kind: MarkdownDiagramKind
    let text: String
    @Environment(\.dismiss) private var dismiss
    @StateObject private var state = InlineDiagramViewState()

    var body: some View {
        let size = ArtifactViewerLayout.size(available: NSApp.keyWindow?.screen?.visibleFrame.size
            ?? NSScreen.main?.visibleFrame.size ?? CGSize(width: 1440, height: 900))
        VStack(spacing: 0) {
            HStack {
                Text("\(kind.rawValue.uppercased()) diagram").font(.headline)
                Spacer()
                Button(state.source ? "Preview" : "Source") { state.source.toggle() }
                CopyButton(text: text)
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(14)
            Divider()
            if state.source {
                ScrollView { CodeBlock(language: kind.rawValue, text: text) }
            } else {
                InlineDiagramPreview(kind: kind, text: text, expanded: true)
            }
        }
        .frame(width: size.width, height: size.height)
    }
}

private struct InlineDiagramPreview: View {
    let kind: MarkdownDiagramKind
    let text: String
    var expanded = false
    var onOpen: (() -> Void)?
    @StateObject private var render = ArtifactRenderState()
    @StateObject private var layout: InlineDiagramLayout

    init(kind: MarkdownDiagramKind, text: String, expanded: Bool = false, onOpen: (() -> Void)? = nil) {
        self.kind = kind
        self.text = text
        self.expanded = expanded
        self.onOpen = onOpen
        // The expanded viewer has a different width, so only inline previews share measurements.
        _layout = StateObject(wrappedValue: expanded ? InlineDiagramLayout() : InlineDiagramLayout(kind: kind, source: text))
    }

    var body: some View {
        if let error = render.error {
            VStack(alignment: .leading, spacing: 8) {
                Text("Could not render \(kind.rawValue): \(error)")
                    .font(.caption).foregroundStyle(Theme.mutedForeground).padding(.horizontal, 10)
                CodeBlock(language: kind.rawValue, text: text)
            }.padding(.top, 8)
        } else {
            GeometryReader { geometry in
                InlineDiagramWebView(kind: kind, source: text, width: geometry.size.width,
                                     state: render, layout: layout, expanded: expanded)
                    .allowsHitTesting(onOpen == nil)
                    .accessibilityHidden(onOpen != nil)
                    .overlay { if render.loading { ProgressView("Rendering diagram…") } }
                    .overlay {
                        if let onOpen {
                            EmbeddedPreviewButton(title: "Expand \(kind.rawValue) diagram",
                                help: "Click to expand diagram", open: onOpen)
                        }
                    }
            }
            .frame(height: expanded ? nil : layout.height)
        }
    }
}

/// Only trusted bootstrap/library JavaScript runs. Diagram source is inert data, not HTML.
struct InlineDiagramWebView: NSViewRepresentable {
    @EndpointClient private var endpoint
    let kind: MarkdownDiagramKind
    let source: String
    let width: CGFloat
    @ObservedObject var state: ArtifactRenderState
    @ObservedObject var layout: InlineDiagramLayout
    var expanded = false

    func makeCoordinator() -> Coordinator { Coordinator(state: state, layout: layout) }

    func makeNSView(context: Context) -> WKWebView {
        Self.makeView(kind: kind, source: source, coordinator: context.coordinator,
                      client: endpoint, expanded: expanded)
    }

    /// Shared with the native renderer integration test.
    static func makeView(kind: MarkdownDiagramKind, source: String, coordinator: Coordinator,
                         client: PilotClient, expanded: Bool = false) -> WKWebView {
        let libraries = ArtifactLibraryHandler(libraries: kind == .mermaid ? [.mermaid] : [], client: client)
        let view = ArtifactWebView.makeSandboxView(coordinator: coordinator.sandbox, libraries: libraries)
        // The drawing opens fitted to the viewer; pinch to enlarge it there, never inline.
        view.allowsMagnification = expanded
        coordinator.sandbox.onLoad = { [weak coordinator] view in coordinator?.render(view) }
        coordinator.sandbox.install(in: view, document: InlineDiagramDocument.document(kind: kind, source: source, expanded: expanded))
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
                    } else {
                        let natural = (result?["natural"] as? [Double]).flatMap(Self.size)
                        let height = result?["height"] as? Double
                        if let natural { self.layout.update(natural: natural, width: self.width) }
                        // Before the first layout pass, or without a natural size, use the page's measurement.
                        if natural == nil || self.layout.width == 0, let height {
                            self.layout.update(height)
                        } else if natural == nil {
                            self.sandbox.state.error = "Renderer returned no diagram"
                        }
                    }
                    self.sandbox.state.loading = false
                } catch { self.fail(error) }
            }
        }

        func resize(_ view: WKWebView, width: CGFloat) {
            guard abs(self.width - width) > 1 else { return }
            self.width = width
            // Known natural size: compute the new height directly, no page round trip.
            if layout.resize(width: width) { return }
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

        private static func size(_ values: [Double]) -> CGSize? {
            guard values.count == 2, values.allSatisfy({ $0.isFinite && $0 > 0 }) else { return nil }
            return CGSize(width: values[0], height: values[1])
        }

        private func fail(_ error: Error) {
            guard sandbox.active, !Task.isCancelled else { return }
            sandbox.state.error = error.localizedDescription
            sandbox.state.loading = false
        }
    }
}
