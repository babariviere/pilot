import AppKit
import Combine
import PilotCore
import SwiftUI
import WebKit

/// The existing native bitmap engine and faithful WebKit fallback, embedded directly in AppKit.
/// Parsing/raster work stays off-main; source, appearance, width and resource changes fence results.
final class NativeDiagramBlock: NSView {
    private let image = NSImageView()
    private let expand = NativeTranscriptButton(icon: PilotIcon.expand)
    private let error = NSTextField(wrappingLabelWithString: "")
    private var kind = MarkdownDiagramKind.mermaid
    private var source = ""
    private var native: NativeMermaidLayout?
    private var environment: EnvironmentValues?
    private var client: PilotClient?
    private var selection: MessageTextSelection?
    private var block = 0
    private var sourceShown = false
    private var nativeFailed = false
    private var code: NativeCodeBlock?
    private var web: WKWebView?
    private var coordinator: InlineDiagramWebView.Coordinator?
    private var render = ArtifactRenderState()
    private var diagramLayout = InlineDiagramLayout()
    private var observations: [AnyCancellable] = []
    private var refreshScheduled = false
    private var drawing: Task<Void, Never>?
    private var requestedImage: NativeMermaid.ImageKey?
    private var generation = UUID()
    private var changed: (() -> Void)?
    var nativeTextViews: [MessageSelectionTextView] { code.map { [$0.text] } ?? [] }
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = Theme.Radius.control
        layer?.masksToBounds = true
        image.imageScaling = .scaleAxesIndependently
        image.setAccessibilityRole(.image)
        error.font = .systemFont(ofSize: Theme.TextRole.caption.size)
        error.textColor = NSColor(Theme.mutedForeground)
        error.isHidden = true
        addSubview(image)
        addSubview(error)
        expand.onPress = { [weak self] in self?.open() }
        addSubview(expand)
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func update(kind: MarkdownDiagramKind, source: String, native: NativeMermaidLayout?,
                selection: MessageTextSelection, block: Int, environment: EnvironmentValues,
                changed: @escaping () -> Void) {
        let nextClient = environment.hostViewContext.map { $0.hosts.presentationClient($0.host) } ?? AppModel.shared.client
        let rebound = self.selection !== selection || self.source != source || self.kind != kind || client !== nextClient
        if rebound {
            releaseRenderer()
            observations.removeAll()
            generation = UUID()
            refreshScheduled = false
            sourceShown = false
            nativeFailed = false
            self.source = source
            self.kind = kind
            render = ArtifactRenderState()
            diagramLayout = InlineDiagramLayout(kind: kind, source: source)
            let generation = generation
            // Published values arrive before mutation. Read once on the next main-actor turn.
            observations = [render.objectWillChange, diagramLayout.objectWillChange].map { publisher in
                publisher.sink { [weak self] _ in
                    self?.scheduleRefresh(generation)
                }
            }
        }
        self.native = native
        self.selection = selection
        self.block = block
        self.environment = environment
        self.client = nextClient
        self.changed = changed
        image.setAccessibilityLabel(native?.altText ?? "\(kind.rawValue.uppercased()) diagram")
        expand.setAccessibilityLabel("Expand \(kind.rawValue) diagram")
        expand.toolTip = "Click to expand diagram"
        needsLayout = true
    }

    private func scheduleRefresh(_ generation: UUID) {
        guard !refreshScheduled else { return }
        refreshScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == generation else { return }
            self.refreshScheduled = false
            self.needsLayout = true
            self.changed?()
        }
    }

    @discardableResult
    func measure(width: CGFloat) -> CGSize {
        guard let environment else { return .zero }
        expand.isHidden = sourceShown || render.error != nil
        expand.frame = NSRect(x: max(0, width - 32), y: 6, width: 26, height: 26)
        if sourceShown || render.error != nil {
            let view = code ?? NativeCodeBlock()
            if code == nil { code = view; addSubview(view) }
            view.update(source: source, language: kind.rawValue, prepared: nil, fonts: environment.pilotFonts,
                        selection: selection, block: block, menu: environment.nativeTranscriptMenu,
                        openURL: environment.openURL, changed: { [weak self] in self?.changed?() })
            let size = view.measure(width: width)
            let errorHeight: CGFloat = render.error == nil ? 0 : 30
            view.frame = NSRect(x: 0, y: errorHeight, width: width, height: size.height)
            error.isHidden = errorHeight == 0
            error.stringValue = render.error.map { "Could not render \(kind.rawValue): \($0)" } ?? ""
            error.frame = NSRect(x: 10, y: 6, width: max(1, width - 20), height: 24)
            image.isHidden = true
            web?.isHidden = true
            return CGSize(width: width, height: size.height + errorHeight)
        }
        code?.stop(); code = nil
        error.isHidden = true
        if let native, !nativeFailed {
            let height = DiagramLayout.inlineHeight(natural: native.natural, availableWidth: width) ?? DiagramLayout.inlineMinHeight
            let fitted = DiagramLayout.inlineDrawingSize(natural: native.natural, availableWidth: width) ?? .zero
            image.frame = NSRect(x: (width - fitted.width) / 2, y: (height - fitted.height) / 2,
                                 width: fitted.width, height: fitted.height)
            image.isHidden = false
            requestImage(native, size: fitted)
            return CGSize(width: width, height: height)
        }
        image.isHidden = true
        if window != nil, web == nil, let client {
            let coordinator = InlineDiagramWebView.Coordinator(state: render, layout: diagramLayout)
            self.coordinator = coordinator
            let view = InlineDiagramWebView.makeView(kind: kind, source: source, coordinator: coordinator, client: client)
            web = view
            addSubview(view, positioned: .below, relativeTo: error)
            view.setAccessibilityElement(false)
        }
        if let web {
            web.isHidden = false
            coordinator?.resize(web, width: width)
            web.frame = NSRect(x: 0, y: 0, width: width, height: diagramLayout.height)
        }
        return CGSize(width: width, height: diagramLayout.height)
    }

    private func requestImage(_ native: NativeMermaidLayout, size: CGSize) {
        guard let window, size.width > 0, size.height > 0 else { return }
        let key = NativeMermaid.ImageKey(source: source, dark: effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua,
            width: Int((size.width * window.backingScaleFactor).rounded()),
            height: Int((size.height * window.backingScaleFactor).rounded()))
        guard requestedImage != key else { return }
        requestedImage = key
        drawing?.cancel()
        if let cached = NativeMermaid.cachedImage(key) {
            image.image = NSImage(cgImage: cached, size: size)
            return
        }
        let generation = generation
        let hadImage = image.image != nil
        drawing = Task { [weak self] in
            if hadImage { try? await Task.sleep(for: .milliseconds(150)) }
            guard !Task.isCancelled else { return }
            let result = await NativeMermaid.image(native, key: key)
            guard !Task.isCancelled, let self, self.generation == generation, self.requestedImage == key else { return }
            self.drawing = nil
            if let result {
                self.image.image = NSImage(cgImage: result, size: size)
            } else {
                self.nativeFailed = true
                self.needsLayout = true
                self.changed?()
            }
        }
    }

    override func layout() {
        super.layout()
        _ = measure(width: max(1, bounds.width))
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { releaseRenderer() }
        needsLayout = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsLayout = true
    }

    // Diagrams open on click, not the embedded fallback page. Source mode keeps text selection.
    override func hitTest(_ point: NSPoint) -> NSView? {
        if !sourceShown, render.error == nil { return bounds.contains(convert(point, from: superview)) ? self : nil }
        return super.hitTest(point)
    }

    override func mouseDown(with event: NSEvent) { open() }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        for (title, action) in [("Expand diagram", #selector(open)),
                                (sourceShown ? "Show preview" : "Show source", #selector(toggleSource)),
                                ("Copy source", #selector(copySource))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        environment?.nativeTranscriptMenu?(menu)
        return menu
    }

    @objc private func open() {
        guard let environment else { return }
        environment.nativeTranscriptPresent?(.init(content: .diagram(kind, source, nativeFailed ? nil : native),
                                                   environment: environment))
    }

    @objc private func toggleSource() {
        environment?.transcriptMessageToggled?()
        sourceShown.toggle()
        needsLayout = true
        changed?()
    }

    @objc private func copySource() { MessageCopyButton.copy(source) }

    private func releaseRenderer() {
        drawing?.cancel(); drawing = nil
        requestedImage = nil
        image.image = nil
        if let web, let coordinator { InlineDiagramWebView.dismantleNSView(web, coordinator: coordinator) }
        web?.removeFromSuperview(); web = nil
        coordinator = nil
    }

    func stop() {
        generation = UUID()
        observations.removeAll()
        releaseRenderer()
        code?.stop(); code = nil
        selection = nil
        changed = nil
        environment = nil
        removeFromSuperview()
    }
}
