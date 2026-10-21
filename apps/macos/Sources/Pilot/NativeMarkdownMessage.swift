import AppKit
import PilotCore
import SwiftUI

/// Native message layout. Preparation is shared with the existing renderer and still happens off-main.
/// Stable blocks and their TextKit storage survive each chunk. Only preparation/real width changes measure.
final class NativeMarkdownMessage: NSView {
    private var source: String?
    private var fonts: PilotFonts?
    private var environment: EnvironmentValues?
    /// Awaitable current work, including cancellation, without polling the main actor on a deadline.
    private(set) var preparation: Task<Void, Never>?
    private var generation = UUID()
    private var blocks: [NativeMarkdownBlockView] = []
    private var preparedBlocks: [PreparedMarkdownBlock] = []
    private var selection: MessageTextSelection?
    private var changed: (() -> Void)?
    private var measuredWidth: CGFloat = 0
    private var measuredHeight: CGFloat = 0
    private(set) var preparedSource: String?
    var nativeTextViews: [MessageSelectionTextView] { blocks.flatMap(\.nativeTextViews) }
    private var dirty = true
    private let copyButton = NSButton()
    private let time = NSTextField(labelWithString: "")
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        copyButton.isBordered = false
        copyButton.image = PilotIcon.copy.menuImage
        copyButton.toolTip = "Copy message"
        copyButton.setAccessibilityLabel("Copy message")
        copyButton.target = self
        copyButton.action = #selector(copyMessage)
        copyButton.alphaValue = 0
        copyButton.contentTintColor = NSColor(Theme.mutedForeground)
        addSubview(copyButton)
        time.font = .systemFont(ofSize: Theme.TextRole.caption.size)
        time.textColor = NSColor(Theme.mutedForeground)
        time.alphaValue = 0
        addSubview(time)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(source: String, timestamp: Double?, streaming: Bool, selection: MessageTextSelection,
                environment: EnvironmentValues, changed: @escaping () -> Void) {
        self.changed = changed
        self.environment = environment
        let selectionChanged = self.selection !== selection
        self.selection = selection
        selection.source = source
        time.stringValue = timestamp.flatMap { MessageTimeFormatting.label($0) } ?? ""
        time.toolTip = timestamp.flatMap { MessageTimeFormatting.detail($0) }
        let fonts = environment.pilotFonts
        guard self.source != source || self.fonts != fonts else {
            if selectionChanged { apply(preparedBlocks, streaming: false, initial: true) }
            return
        }
        let initial = self.source == nil
        let previous = preparedSource
        self.source = source
        self.fonts = fonts
        preparation?.cancel()
        preparation = nil
        generation = UUID()
        let generation = generation
        if initial {
            if let prepared = PreparedMarkdownCache.shared.blocks(for: source) {
                // Recycled rows already have rich preparation. Do not publish a plain-text height first.
                apply(prepared, streaming: false, initial: true)
                preparedSource = source
                return
            }
            // A newly realized row is immediately readable while its rich preparation is pending.
            let plain = PreparedMarkdownBlock(id: -1, block: .paragraph(source), inline: AttributedString(source), items: [], code: nil)
            apply([plain], streaming: false, initial: true)
        }
        preparation = Task { [weak self] in
            guard let prepared = try? await MarkdownRenderer.shared.prepare(source, streaming: streaming),
                  !Task.isCancelled, let self, self.generation == generation else { return }
            PreparedMarkdownCache.shared.store(prepared, for: source, replacing: previous)
            self.apply(prepared, streaming: streaming && !environment.accessibilityReduceMotion, initial: initial)
            self.preparedSource = source
            self.preparation = nil
            self.changed?()
        }
    }

    private func apply(_ prepared: [PreparedMarkdownBlock], streaming: Bool, initial: Bool) {
        guard let environment, let selection else { return }
        preparedBlocks = prepared
        while blocks.count > prepared.count { blocks.removeLast().stop() }
        for (index, block) in prepared.enumerated() {
            let new = index >= blocks.count
            if new {
                let view = NativeMarkdownBlockView()
                blocks.append(view)
                addSubview(view, positioned: .below, relativeTo: copyButton)
            }
            blocks[index].update(block, index: index, selection: selection, environment: environment,
                                 streaming: streaming, fadesInitial: new && !initial,
                                 changed: { [weak self] in
                                     self?.dirty = true
                                     self?.changed?()
                                 })
        }
        dirty = true
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        guard dirty || width != measuredWidth else { return measuredHeight }
        var y: CGFloat = 0
        for (index, block) in blocks.enumerated() {
            if index > 0 { y += 10 }
            let height = block.measure(width: width)
            block.frame = NSRect(x: 0, y: y, width: width, height: height)
            y += height
        }
        measuredWidth = width
        measuredHeight = ceil(y + 24) // The existing fixed action slot: 4 pt gap, 20 pt footer.
        dirty = false
        return measuredHeight
    }

    override func layout() {
        super.layout()
        _ = measure(width: max(1, bounds.width))
        let y = measuredHeight - 20
        copyButton.frame = NSRect(x: 0, y: y, width: 24, height: 20)
        time.frame = NSRect(x: 32, y: y + 2, width: max(0, bounds.width - 32), height: 18)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        tracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { copyButton.alphaValue = 1; time.alphaValue = 1 }
    override func mouseExited(with event: NSEvent) { copyButton.alphaValue = 0; time.alphaValue = 0 }
    @objc private func copyMessage() { if let source { MessageCopyButton.copy(source) } }

    /// Reset identity/work while retaining the bounded mounted regions for the next message in this cell.
    func resetMessageBinding() {
        generation = UUID()
        preparation?.cancel(); preparation = nil
        source = nil
        preparedSource = nil
        preparedBlocks = []
        selection = nil
        changed = nil
        dirty = true
        copyButton.alphaValue = 0
        time.alphaValue = 0
    }

    func stop() {
        resetMessageBinding()
        for block in blocks { block.stop() }
        blocks = []
        removeFromSuperview()
    }
}

/// Native text, list markers, quote rules and dividers. Complex block views are temporary compatibility hosts
/// behind the flag, removed with the remaining native row migration. They share the message's selection owner.
final class NativeMarkdownBlockView: NSView {
    private var blockID: Int?
    private weak var selection: MessageTextSelection?
    private var fonts: PilotFonts?
    private var textViews: [MessageSelectionTextView] = []
    private var labels: [NSTextField] = []
    private var host: TranscriptRowHost?
    private var hostContent: AnyView?
    private var hostWidth: CGFloat = 0
    private var quoteRule: NSView?
    private var kind: MarkdownBlock?
    private var changed: (() -> Void)?
    private var top: CGFloat = 0
    private var indent: CGFloat = 0
    private var itemSpacing: CGFloat = 0
    private var lastWidth: CGFloat = 0
    private var height: CGFloat = 0
    private var dirty = true
    var nativeTextViews: [MessageSelectionTextView] { textViews }
    override var isFlipped: Bool { true }

    func update(_ block: PreparedMarkdownBlock, index: Int, selection: MessageTextSelection,
                environment: EnvironmentValues, streaming: Bool, fadesInitial: Bool, changed: @escaping () -> Void) {
        self.changed = changed
        let fonts = environment.pilotFonts
        guard blockID != block.id || self.fonts != fonts || self.selection !== selection else { return }
        self.selection = selection
        blockID = block.id
        self.fonts = fonts
        kind = block.block
        top = 0; indent = 0; itemSpacing = 0
        var values: [AttributedString] = []
        var markers: [String] = []
        var font = fonts.nsBody
        var spacing: CGFloat = 3
        var color = NSColor(Theme.foreground)
        var prefixes: [String] = []
        var native = true
        switch block.block {
        case let .paragraph(text): values = [block.inline ?? AttributedString(text)]
        case let .heading(level, text):
            values = [block.inline ?? AttributedString(text)]
            font = fonts.nsChat(fonts.chatSize + (level == 1 ? 6 : level == 2 ? 3 : 1), weight: .semibold)
            spacing = 0; top = 4
        case let .list(ordered, start, items):
            values = block.items
            markers = items.indices.map { ordered ? "\(start + $0)." : "•" }
            prefixes = markers.map { $0 + " " }
            itemSpacing = 5
        case let .quote(text):
            values = [block.inline ?? AttributedString(text)]
            indent = 13; spacing = 0; color = NSColor(Theme.mutedForeground)
        case .rule: break
        default: native = false
        }
        if native {
            host?.onSizeChanged = nil; host?.removeFromSuperview(); host = nil; hostContent = nil
            while textViews.count > values.count { removeText(textViews.removeLast()) }
            for (item, value) in values.enumerated() {
                if item >= textViews.count {
                    let text = MessageSelectionTextView.makeReadOnly()
                    textViews.append(text); addSubview(text)
                }
                let text = textViews[item]
                if text.selectionOwner !== selection { text.setSelectedRange(NSRange(location: 0, length: 0)) }
                text.selectionOwner?.unregister(text)
                text.selectionOwner = selection
                text.selectionKey = .init(block: index, item: item)
                text.copyPrefix = item < prefixes.count ? prefixes[item] : ""
                let style = MessageSelectionTextView.Style(font: font, mono: fonts.nsMono, color: color, spacing: spacing)
                if text.content != value || text.style != style {
                    StreamingTrace.measure(.textUpdate) {
                        let attributed = SelectableMessageText.attributed(value, style: style)
                        let first = text.content == nil
                        let start = text.style == style ? text.textStorage.flatMap { text.replaceChangedTail($0, with: attributed) } : nil
                        if start == nil { text.textStorage?.setAttributedString(attributed) }
                        if streaming, let from = start ?? (first && fadesInitial ? 0 : nil) {
                            text.fadeIn(NSRange(location: from, length: attributed.length - from), from: NSColor(Theme.background))
                        }
                        text.content = value; text.style = style
                        text.invalidateMeasurements()
                    }
                }
                selection.register(text)
            }
            for label in labels { label.removeFromSuperview() }
            labels = markers.map { marker in
                let label = NSTextField(labelWithString: marker)
                label.font = fonts.nsBody
                label.textColor = NSColor(Theme.mutedForeground)
                label.alignment = .right
                addSubview(label)
                return label
            }
            if !markers.isEmpty { indent = max(14, labels.map { ceil($0.intrinsicContentSize.width) }.max() ?? 14) + 8 }
            let rule: Bool
            switch block.block { case .quote, .rule: rule = true; default: rule = false }
            if rule, quoteRule == nil {
                let view = NSView(); view.wantsLayer = true
                quoteRule = view; addSubview(view)
            } else if !rule { quoteRule?.removeFromSuperview(); quoteRule = nil }
            quoteRule?.layer?.backgroundColor = NSColor(Theme.faintForeground).cgColor
        } else {
            for text in textViews { removeText(text) }; textViews = []
            for label in labels { label.removeFromSuperview() }; labels = []
            quoteRule?.removeFromSuperview(); quoteRule = nil
            let root = AnyView(BlockView(block: block, hugsContent: false)
                // Reusing a host must not carry interactive SwiftUI state into a different message.
                .id(ObjectIdentifier(selection))
                .environment(\.self, environment)
                .environment(\.messageTextSelection, selection)
                .environment(\.messageSelectionBlock, index)
                .environment(\.messageSelectionColor, NSColor(Theme.foreground))
                .environment(\.messageTextFade, streaming ? NSColor(Theme.background) : nil)
                .environment(\.messageTextFadesInitial, fadesInitial)
                .environment(\.transcriptContentPrepared, changed))
            hostContent = root
            hostWidth = 0
            if let host { host.rootView = root } else {
                let view = TranscriptRowHost(rootView: root)
                host = view; addSubview(view)
            }
            host?.onSizeChanged = { [weak self] in self?.dirty = true; self?.changed?() }
        }
        dirty = true
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        guard dirty || width != lastWidth else { return height }
        lastWidth = width
        var y = top
        if let host, let hostContent {
            if hostWidth != width {
                hostWidth = width
                host.rootView = AnyView(hostContent.frame(width: width, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true))
            }
            host.frame.size.width = width
            y = host.measuredContentHeight()
            host.frame = NSRect(x: 0, y: 0, width: width, height: y)
        } else {
            for (index, text) in textViews.enumerated() {
                if index > 0 { y += itemSpacing }
                let size = text.measure(width: max(1, width - indent), unwrapped: false)
                text.frame = NSRect(x: indent, y: y, width: max(1, width - indent), height: size.height)
                if index < labels.count {
                    labels[index].frame = NSRect(x: 0, y: y, width: max(0, indent - 8), height: size.height)
                }
                y += size.height
            }
            if case .rule = kind {
                y = 9
                quoteRule?.frame = NSRect(x: 0, y: 4, width: width, height: 1)
            } else { quoteRule?.frame = NSRect(x: 0, y: 0, width: 3, height: y) }
        }
        height = y
        dirty = false
        return height
    }

    private func removeText(_ text: MessageSelectionTextView) {
        text.selectionOwner?.unregister(text)
        text.selectionOwner = nil
        text.removeFromSuperview()
    }

    func stop() {
        for text in textViews { removeText(text) }
        textViews = []
        host?.onSizeChanged = nil
        host?.removeFromSuperview(); host = nil
        changed = nil
        removeFromSuperview()
    }
}
