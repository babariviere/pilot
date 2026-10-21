import AppKit
import PilotCore
import SwiftUI
import WebKit

/// Native card chrome and geometry, with direct WebKit/native-image embeddings. The existing visual
/// component is a content engine, not a hosted conversation row; its controls and state remain live.
final class NativeArtifactRow: NSView, NativeRowContent {
    private let paper = NativeArtifactPaper()
    private let expand = NativeTranscriptButton(icon: PilotIcon.expand)
    private let reveal = NativeTranscriptButton()
    private let loading = NSTextField(labelWithString: "Loading artifact…")
    private let spinner = EllipsisSpinnerView()
    private let failureTitle = NSTextField(labelWithString: "Couldn't load this artifact")
    private let failure = NSTextField(wrappingLabelWithString: "")
    private let retry = NativeTranscriptButton("Retry")
    private let image = NSImageView()
    private var web: WKWebView?
    private var webCoordinator: ArtifactWebView.Coordinator?
    private var visual: NativeVisualRenderer?
    private var revision: ArtifactRevision?
    private var render = ArtifactRenderState()
    private let observation = NativeRowObservation()
    private var reference: ArtifactReference?
    private var context: NativeRowContext?
    private var client: PilotClient?
    private var host: HostRef?
    private var generation = UUID()
    private var loadingTask: Task<Void, Never>?
    private var imageTask: Task<Void, Never>?
    private var imageSide = 0
    private var loadError: String?
    private var preview = true
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true; layer?.masksToBounds = true
        layer?.cornerRadius = Theme.Radius.control
        loading.font = .systemFont(ofSize: Theme.TextRole.caption.size)
        loading.textColor = NSColor(Theme.mutedForeground)
        failureTitle.font = .systemFont(ofSize: Theme.TextRole.headline.size, weight: .semibold)
        failureTitle.textColor = NSColor(Theme.foreground)
        failure.font = .systemFont(ofSize: Theme.TextRole.caption.size)
        failure.textColor = NSColor(Theme.mutedForeground)
        expand.onPress = { [weak self] in self?.open() }
        reveal.onPress = { [weak self] in self?.togglePreview() }
        retry.onPress = { [weak self] in self?.startLoading(force: true) }
        retry.setAccessibilityLabel("Retry loading artifact")
        image.imageScaling = .scaleProportionallyDown
        image.animates = true
        for view in [paper, image, spinner, loading, failureTitle, failure, retry, reveal, expand] { addSubview(view) }
        setAccessibilityElement(true); setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func bind(_ row: ChatRow, context: NativeRowContext) {
        guard case let .artifact(_, reference) = row else { return }
        update(reference: reference, context: context)
    }

    func update(reference: ArtifactReference, context: NativeRowContext) {
        let nextClient = context.environment.hostViewContext.map { $0.hosts.presentationClient($0.host) } ?? AppModel.shared.client
        let nextHost = context.environment.hostViewContext?.host ?? context.resource.host ?? nextClient.hostIdentity
        if self.reference != reference || host != nextHost || client !== nextClient {
            releaseRenderer()
            loadingTask?.cancel(); loadingTask = nil
            generation = UUID()
            self.reference = reference; host = nextHost; client = nextClient
            revision = ArtifactInlineCache.revision(for: reference, host: nextHost)
            render = ArtifactRenderState()
            render.contentSize = ArtifactInlineCache.contentSize(for: reference, host: nextHost)
            preview = true; loadError = nil
        }
        self.context = context
        var publishers = [render.objectWillChange]
        if let hosts = context.environment.hostViewContext?.hosts { publishers.append(hosts.objectWillChange) }
        observation.bind(publishers) { [weak self] in
            guard let self, let reference = self.reference, let context = self.context else { return }
            self.update(reference: reference, context: context)
            ArtifactInlineCache.storeContentSize(self.render.contentSize, for: reference, host: self.host)
            self.context?.changed()
        }
        setAccessibilityLabel(reference.title)
        expand.setAccessibilityLabel("Open \(reference.title) in the viewer")
        expand.toolTip = "Open in the viewer"
        reveal.title = "Show \(reference.title)"
        image.setAccessibilityLabel(reference.title)
        if window != nil {
            startLoading()
            mountRenderer()
        }
        needsLayout = true
    }

    private func startLoading(force: Bool = false) {
        guard let reference, let client, preview, loadingTask == nil, force || revision == nil,
              force || (loadError == nil && render.error == nil) else { return }
        if force {
            releaseRenderer(); revision = nil; render.error = nil; loadError = nil
            generation = UUID()
        }
        let generation = generation
        loadingTask = Task { [weak self] in
            do {
                let revision = try await client.artifact(reference, latest: false)
                try Task.checkCancellation()
                guard revision.id == reference.id, revision.sessionId == reference.sessionId,
                      revision.revision == reference.revision else { throw ClientError("Artifact revision did not match this card") }
                guard let self, self.generation == generation else { return }
                self.revision = revision
                ArtifactInlineCache.store(revision, for: reference, host: self.host)
                self.loadError = nil
                self.loadingTask = nil
                self.mountRenderer()
                self.needsLayout = true
                self.context?.changed()
            } catch {
                guard !Task.isCancelled, let self, self.generation == generation else { return }
                self.loadError = error.localizedDescription
                self.loadingTask = nil
                self.needsLayout = true
                self.context?.changed()
            }
        }
    }

    private func mountRenderer() {
        guard preview, window != nil, let revision, let context, let client else { return }
        if revision.kind == .image {
            requestImage(revision)
        } else if revision.kind == .visual {
            guard visual == nil, let reference else { return }
            let view = NativeVisualRenderer(revision: revision, key: ArtifactInlineCache.sizeKey(reference, host),
                                            render: render, environment: context.environment)
            visual = view; addSubview(view, positioned: .below, relativeTo: expand)
        } else if web == nil {
            let coordinator = ArtifactWebView.Coordinator(state: render)
            let composer = context.environment.transcriptComposer
            let view = ArtifactWebView.makeView(revision: revision, client: client, coordinator: coordinator, inline: true,
                                                onEscape: { [weak composer] in composer?.composerFocus = UUID() })
            webCoordinator = coordinator; web = view
            addSubview(view, positioned: .below, relativeTo: expand)
        }
    }

    private func requestImage(_ revision: ArtifactRevision) {
        let side = Int(ceil(max(bounds.width, ArtifactViewerLayout.inlineImageMaxHeight) * (window?.backingScaleFactor ?? 2)))
        guard side != imageSide else { return }
        imageSide = side
        imageTask?.cancel()
        let generation = generation
        imageTask = Task { [weak self] in
            do {
                let result = try await NativeArtifactImage.shared.decode(revision, maxSide: side)
                guard !Task.isCancelled, let self, self.generation == generation, self.imageSide == side else { return }
                self.image.image = result.image
                self.render.contentSize = result.natural
                self.render.loading = false
                self.imageTask = nil
            } catch {
                guard !Task.isCancelled, let self, self.generation == generation else { return }
                self.render.error = error.localizedDescription
                self.imageTask = nil
            }
        }
    }

    func measure(width: CGFloat) -> CGFloat {
        if !preview {
            reveal.frame = NSRect(x: 0, y: 0, width: width, height: 24)
            for view in [paper, image, spinner, loading, failureTitle, failure, retry, expand] { view.isHidden = true }
            reveal.isHidden = false
            return 24
        }
        let error = loadError ?? render.error
        let size = ArtifactViewerLayout.inlineSize(availableWidth: width, contentSize: render.contentSize,
            image: revision?.kind == .image || revision?.kind == .swiftui, visual: revision?.kind == .visual)
        paper.frame = NSRect(origin: .zero, size: size)
        paper.isHidden = revision?.kind == .visual
        reveal.isHidden = true
        let waiting = revision == nil && error == nil
        spinner.isHidden = !waiting; spinner.animates = waiting && context?.environment.accessibilityReduceMotion != true
        loading.isHidden = !waiting
        let labelWidth = min(max(1, size.width - 36), loading.intrinsicContentSize.width)
        loading.frame = NSRect(x: (size.width - labelWidth) / 2 + 10, y: (size.height - 20) / 2, width: labelWidth, height: 20)
        spinner.frame = NSRect(x: max(0, loading.frame.minX - 22), y: loading.frame.minY + 2, width: 14, height: 14)
        failureTitle.isHidden = error == nil; failure.isHidden = error == nil; retry.isHidden = error == nil
        failure.stringValue = error ?? ""
        failure.alignment = .center; failureTitle.alignment = .center
        failureTitle.frame = NSRect(x: 12, y: size.height / 2 - 44, width: max(1, size.width - 24), height: 22)
        failure.frame = NSRect(x: 12, y: size.height / 2 - 16, width: max(1, size.width - 24), height: 44)
        retry.frame = NSRect(x: (size.width - 64) / 2, y: size.height / 2 + 32, width: 64, height: 24)
        image.isHidden = revision?.kind != .image || error != nil
        image.frame = NSRect(origin: .zero, size: size)
        web?.frame = NSRect(origin: .zero, size: size)
        web?.isHidden = error != nil
        visual?.place(width: size.width, height: size.height)
        visual?.isHidden = error != nil
        expand.isHidden = revision == nil || error != nil
        expand.frame = NSRect(x: max(0, size.width - 36), y: 8, width: 28, height: 28)
        if revision?.kind == .image, let revision, window != nil { requestImage(revision) }
        return size.height
    }

    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            loadingTask?.cancel(); loadingTask = nil
            releaseRenderer()
        } else {
            startLoading(); mountRenderer(); needsLayout = true
        }
    }
    override func mouseDown(with event: NSEvent) {
        if revision?.kind == .image || revision?.kind == .swiftui { open() } else { super.mouseDown(with: event) }
    }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        if preview, revision?.kind == .image || revision?.kind == .swiftui, hit != nil, hit !== expand { return self }
        return hit
    }
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        nativeMenuAction(menu, "Open artifact", icon: PilotIcon.expand) { [weak self] in self?.open() }
        nativeMenuAction(menu, preview ? "Hide preview" : "Show preview") { [weak self] in self?.togglePreview() }
        return menu
    }
    func activate() -> Bool { open(); return true }
    private func open() {
        guard let reference, let environment = context?.environment else { return }
        environment.nativeTranscriptPresent?(.init(content: .artifact(reference), environment: environment))
    }
    private func togglePreview() {
        context?.environment.transcriptMessageToggled?()
        preview.toggle()
        if preview { startLoading(); mountRenderer() } else { releaseRenderer() }
        needsLayout = true; context?.changed()
    }
    private func releaseRenderer() {
        loadingTask?.cancel(); loadingTask = nil
        imageTask?.cancel(); imageTask = nil; imageSide = 0; image.image = nil
        if let web, let coordinator = webCoordinator { ArtifactWebView.dismantleNSView(web, coordinator: coordinator) }
        web?.removeFromSuperview(); web = nil; webCoordinator = nil
        visual?.removeFromSuperview(); visual = nil
        spinner.animates = false
    }
    func stop() {
        generation = UUID()
        loadingTask?.cancel(); loadingTask = nil
        releaseRenderer(); observation.stop()
        context = nil; client = nil; reference = nil; revision = nil
        removeFromSuperview()
    }
}

private final class NativeArtifactPaper: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true; layer?.cornerRadius = Theme.Radius.control
        setAccessibilityElement(false)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = NSColor(Theme.artifactPaper).cgColor }
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// A dedicated adapter for the existing visual content engine (charts, canvas, shaders and controls).
/// Width is explicit; there is no RowView, transcript chrome or whole-table SwiftUI sizing subtree.
private final class NativeVisualRenderer: NSView {
    private let host: NSHostingView<AnyView>
    private let content: AnyView
    private var width: CGFloat = 0
    override var isFlipped: Bool { true }

    init(revision: ArtifactRevision, key: String, render: ArtifactRenderState, environment: EnvironmentValues) {
        content = AnyView(VisualArtifactView(revision: revision, memoryKey: key, inline: true, render: render)
            .environment(\.self, environment))
        host = NSHostingView(rootView: content)
        host.sizingOptions = [.intrinsicContentSize]
        super.init(frame: .zero)
        addSubview(host)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    func place(width: CGFloat, height: CGFloat) {
        if self.width != width {
            self.width = width
            host.rootView = AnyView(content.frame(width: width, alignment: .leading).fixedSize(horizontal: false, vertical: true))
        }
        frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.frame = bounds
    }
}
