import AppKit
import PilotCore
import SwiftUI

/// Shared native transcript controls. Their actions survive only the current row binding.
final class NativeTranscriptButton: NSButton {
    var onPress: (() -> Void)?
    var onFocusChanged: (() -> Void)?

    init(_ title: String = "", icon: PilotIcon? = nil, action: (() -> Void)? = nil) {
        super.init(frame: .zero)
        self.title = title
        image = icon?.menuImage
        imagePosition = title.isEmpty ? .imageOnly : .imageLeading
        isBordered = false
        focusRingType = .none
        font = .systemFont(ofSize: Theme.TextRole.caption.size)
        contentTintColor = NSColor(Theme.mutedForeground)
        target = self
        self.action = #selector(pressed)
        onPress = action
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    @objc private func pressed() { onPress?() }
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { DispatchQueue.main.async { [weak self] in self?.onFocusChanged?() } }
        return accepted
    }
    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { DispatchQueue.main.async { [weak self] in self?.onFocusChanged?() } }
        return accepted
    }
}

/// A selectable, syntax-coloured code region, without a SwiftUI row or sizing graph. The native
/// horizontal scroller passes vertical gestures to the transcript, just like Markdown tables.
final class NativeCodeBlock: NSView {
    let text = MessageSelectionTextView.makeReadOnly()
    let scroll = MarkdownTableScrollView()
    private let document = NativeCodeDocument()
    private let header = NSView()
    private let label = NSTextField(labelWithString: "")
    private let copy = NativeTranscriptButton(icon: PilotIcon.copy)
    private var source = ""
    private var language: String?
    private var fonts: PilotFonts?
    private var preparation: Task<Void, Never>?
    private var generation = UUID()
    private var changed: (() -> Void)?
    private var measuredWidth: CGFloat = 0
    private var measuredSize: CGSize = .zero
    private var dirty = true
    private let headerHeight: CGFloat = 28
    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = Theme.Radius.control
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        header.wantsLayer = true
        label.font = .systemFont(ofSize: Theme.TextRole.caption.size)
        label.textColor = NSColor(Theme.mutedForeground)
        copy.toolTip = "Copy code"
        copy.setAccessibilityLabel("Copy code")
        copy.onPress = { [weak self] in
            if let self { MessageCopyButton.copy(self.source) }
        }
        text.unwrapped = true
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false
        scroll.hasVerticalScroller = false
        scroll.horizontalScrollElasticity = .automatic
        scroll.verticalScrollElasticity = .none
        scroll.documentView = document
        document.addSubview(text)
        header.addSubview(label)
        header.addSubview(copy)
        addSubview(header)
        addSubview(scroll)
        setAccessibilityElement(false)
        scroll.setAccessibilityElement(false)
        scroll.contentView.setAccessibilityElement(false)
        document.setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func update(source: String, language: String?, prepared: AttributedString?, fonts: PilotFonts,
                selection: MessageTextSelection? = nil, block: Int = 0, streaming: Bool = false,
                fadesInitial: Bool = false, menu: ((NSMenu) -> Void)? = nil, openURL: OpenURLAction? = nil,
                changed: @escaping () -> Void) {
        self.changed = changed
        text.supplementalMenu = menu
        text.nativeOpenURL = openURL
        let rebound = text.selectionOwner !== selection
        if rebound {
            generation = UUID()
            preparation?.cancel(); preparation = nil
            text.selectionOwner?.unregister(text)
            text.clearMessageSelection()
            scroll.contentView.scroll(to: .zero)
        }
        text.selectionOwner = selection
        text.selectionKey = .init(block: block)
        text.copyPrefix = ""
        label.stringValue = language ?? "code"
        text.setAccessibilityLabel("\(language ?? "Code") code")
        let sourceChanged = self.source != source || self.language != language || self.fonts != fonts
        self.source = source
        self.language = language
        self.fonts = fonts
        if sourceChanged || prepared != nil || text.content == nil {
            apply(prepared ?? AttributedString(source), fonts: fonts, streaming: streaming, fadesInitial: fadesInitial)
        }
        selection?.register(text)
        guard sourceChanged || rebound || prepared != nil else { return }
        preparation?.cancel()
        generation = UUID()
        guard prepared == nil else { return }
        let generation = generation
        preparation = Task { [weak self] in
            guard let value = try? await MarkdownRenderer.shared.prepareCode(source, language: language),
                  !Task.isCancelled, let self, self.generation == generation else { return }
            self.apply(value, fonts: fonts, streaming: false, fadesInitial: false)
            self.preparation = nil
            self.changed?()
        }
    }

    private func apply(_ value: AttributedString, fonts: PilotFonts, streaming: Bool, fadesInitial: Bool) {
        let style = MessageSelectionTextView.Style(font: fonts.nsMono, mono: fonts.nsMono,
                                                  color: NSColor(Theme.foreground), spacing: 0)
        guard text.content != value || text.style != style else { return }
        let attributed = SelectableMessageText.attributed(value, style: style)
        let first = text.content == nil
        let start = text.style == style ? text.textStorage.flatMap { text.replaceChangedTail($0, with: attributed) } : nil
        if start == nil { text.textStorage?.setAttributedString(attributed) }
        if streaming, let from = start ?? (first && fadesInitial ? 0 : nil) {
            text.fadeIn(NSRange(location: from, length: attributed.length - from), from: NSColor(Theme.code))
        }
        text.content = value
        text.style = style
        text.invalidateMeasurements()
        dirty = true
        needsLayout = true
    }

    @discardableResult
    func measure(width: CGFloat) -> CGSize {
        guard dirty || measuredWidth != width else { return measuredSize }
        // Match the drawn unwrapped container. A finite proposed column width would wrap the
        // isolated sizing container and incorrectly make long code many lines tall.
        let size = text.measure(width: 1_000_000, unwrapped: true)
        let contentHeight = size.height + 20
        document.frame = NSRect(x: 0, y: 0, width: max(width, size.width + 20), height: contentHeight)
        text.frame = NSRect(x: 10, y: 10, width: max(1, size.width), height: size.height)
        header.frame = NSRect(x: 0, y: 0, width: width, height: headerHeight)
        label.frame = NSRect(x: 10, y: 6, width: max(0, width - 54), height: 18)
        copy.frame = NSRect(x: max(0, width - 34), y: 4, width: 24, height: 20)
        scroll.frame = NSRect(x: 0, y: headerHeight, width: width, height: contentHeight)
        measuredWidth = width
        measuredSize = CGSize(width: width, height: headerHeight + contentHeight)
        dirty = false
        return measuredSize
    }

    override func layout() {
        super.layout()
        _ = measure(width: max(1, bounds.width))
    }

    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor(Theme.code).cgColor
            layer?.borderColor = NSColor(Theme.border).cgColor
            header.layer?.backgroundColor = NSColor(Theme.muted).cgColor
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    func stop() {
        generation = UUID()
        preparation?.cancel(); preparation = nil
        text.selectionOwner?.unregister(text)
        text.selectionOwner = nil
        text.supplementalMenu = nil
        text.nativeOpenURL = nil
        changed = nil
        removeFromSuperview()
    }
}

private final class NativeCodeDocument: NSView {
    override var isFlipped: Bool { true }
}
