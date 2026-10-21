import AppKit
import Combine
import PilotCore
import QuartzCore
import SwiftUI

@MainActor
struct NativeRowContext {
    let resource: NativeTranscriptResource
    let toolExpansions: TranscriptExpansions
    let messageExpansions: TranscriptExpansions
    let environment: EnvironmentValues
    let selection: (String) -> MessageTextSelection
    let active: Bool
    let changed: () -> Void

    init(configuration: NativeTranscript, selection: @escaping (String) -> MessageTextSelection,
         active: Bool, changed: @escaping () -> Void) {
        resource = configuration.resource
        toolExpansions = configuration.toolExpansions
        messageExpansions = configuration.messageExpansions
        var environment = configuration.environment
        if let host = configuration.resource.host, environment.hostViewContext?.host != host,
           environment.hostViewContext != nil || host != AppModel.shared.localHost {
            let context = HostViewContext(host: host, hosts: environment.hostViewContext?.hosts ?? AppModel.shared.hosts)
            environment.hostViewContext = context
            environment.openURL = context.openURL
        }
        self.environment = environment
        self.selection = selection; self.active = active; self.changed = changed
    }
}

@MainActor
protocol NativeRowContent: AnyObject {
    var nativeView: NSView { get }
    func bind(_ row: ChatRow, context: NativeRowContext)
    func measure(width: CGFloat) -> CGFloat
    func stop()
    func activate() -> Bool
}

extension NativeRowContent where Self: NSView {
    var nativeView: NSView { self }
}

extension NativeRowContent {
    func activate() -> Bool { false }
}

/// Observe only the mounted row's state. Coalesce before-change publications into one post-mutation read.
@MainActor
final class NativeRowObservation {
    private var subscriptions: [AnyCancellable] = []
    private var identities: [ObjectIdentifier] = []
    private var changed: (() -> Void)?
    private var scheduled = false
    private var generation = UUID()

    func bind(_ publishers: [ObservableObjectPublisher], changed: @escaping () -> Void) {
        self.changed = changed
        let identities = publishers.map { ObjectIdentifier($0) }
        guard self.identities != identities else { return }
        stop()
        self.changed = changed
        self.identities = identities
        subscriptions = publishers.map { publisher in
            publisher.sink { [weak self] _ in self?.schedule() }
        }
    }

    private func schedule() {
        guard !scheduled else { return }
        scheduled = true
        let generation = generation
        DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == generation else { return }
            self.scheduled = false
            self.changed?()
        }
    }

    func stop() {
        generation = UUID()
        subscriptions.removeAll()
        identities = []
        changed = nil
        scheduled = false
    }
}

@MainActor
private final class NativeMenuAction: NSObject, NSMenuItemValidation {
    let perform: () -> Void
    let enabled: Bool
    init(_ perform: @escaping () -> Void, enabled: Bool) { self.perform = perform; self.enabled = enabled }
    @objc func run() { perform() }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { enabled }
}

@MainActor
func nativeMenuAction(_ menu: NSMenu, _ title: String, icon: PilotIcon? = nil, enabled: Bool = true,
                      perform: @escaping () -> Void) {
    let target = NativeMenuAction(perform, enabled: enabled)
    let item = NSMenuItem(title: title, action: #selector(NativeMenuAction.run), keyEquivalent: "")
    item.image = icon?.menuImage
    item.target = target
    item.representedObject = target
    item.isEnabled = enabled
    menu.addItem(item)
}

@MainActor
func nativeMessageMenu(row: ChatRow, environment: EnvironmentValues) -> (NSMenu) -> Void {
    let rewind = environment.transcriptRewind
    return { [weak rewind] menu in
        guard let rewind, let entry = row.entryID, let action = row.rewindAction, action != .retry else { return }
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        nativeMenuAction(menu, TranscriptRewind.menuTitle(action),
                         icon: action == .edit ? PilotIcon.edit : PilotIcon.restore, enabled: !rewind.pending) { [weak rewind] in
            guard let rewind, !rewind.pending else { return }
            rewind.request(action, entryID: entry)
        }
    }
}

/// The fixed action slot is outside the bubble, so hover never changes row height.
final class NativeMessageActions: NSView {
    private let copy = NativeTranscriptButton(icon: PilotIcon.copy)
    private let edit = NativeTranscriptButton(icon: PilotIcon.edit)
    private let time = NSTextField(labelWithString: "")
    private var source = ""
    private weak var rewind: TranscriptRewind?
    private var entryID: Int?
    private let observation = NativeRowObservation()
    private var confirmation: Task<Void, Never>?
    private var generation = UUID()
    private var hasEdit = false
    private var hovered = false
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        copy.toolTip = "Copy message"; copy.setAccessibilityLabel("Copy message")
        edit.toolTip = "Edit and resend"; edit.setAccessibilityLabel("Edit and Resend")
        copy.onPress = { [weak self] in self?.copyMessage() }
        edit.onPress = { [weak self] in
            guard let self, let entryID = self.entryID, let rewind = self.rewind, !rewind.pending else { return }
            rewind.request(.edit, entryID: entryID)
        }
        copy.onFocusChanged = { [weak self] in self?.refreshReveal() }
        edit.onFocusChanged = { [weak self] in self?.refreshReveal() }
        time.font = .systemFont(ofSize: Theme.TextRole.caption.size)
        time.textColor = NSColor(Theme.mutedForeground)
        for view in [copy, edit, time] { addSubview(view) }
        reveal(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func update(source: String, timestamp: Double?, entryID: Int?, environment: EnvironmentValues) {
        self.source = source
        self.entryID = entryID
        rewind = environment.transcriptRewind
        hasEdit = entryID != nil && rewind != nil
        edit.isHidden = !hasEdit
        time.stringValue = timestamp.flatMap { MessageTimeFormatting.label($0) } ?? ""
        time.toolTip = timestamp.flatMap { MessageTimeFormatting.detail($0) }
        observation.bind(rewind.map { [$0.objectWillChange] } ?? []) { [weak self] in
            self?.edit.isEnabled = self?.rewind?.pending != true
        }
        edit.isEnabled = rewind?.pending != true
        needsLayout = true
    }

    func reveal(_ shown: Bool) {
        hovered = shown
        refreshReveal()
    }

    private func refreshReveal() {
        let focused = window?.firstResponder === copy || window?.firstResponder === edit
        let opacity: CGFloat = hovered || focused ? 1 : 0
        copy.alphaValue = opacity; edit.alphaValue = opacity; time.alphaValue = opacity
    }

    override func layout() {
        super.layout()
        var x = bounds.width
        if hasEdit { x -= 24; edit.frame = NSRect(x: x, y: 0, width: 24, height: 20); x -= 2 }
        x -= 24
        copy.frame = NSRect(x: x, y: 0, width: 24, height: 20)
        let width = min(max(0, x - 6), ceil(time.intrinsicContentSize.width))
        time.frame = NSRect(x: max(0, x - 6 - width), y: 2, width: width, height: 18)
    }

    private func copyMessage() {
        MessageCopyButton.copy(source)
        confirmation?.cancel()
        copy.image = PilotIcon.done.menuImage
        let generation = generation
        confirmation = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled, let self, self.generation == generation else { return }
            self.copy.image = PilotIcon.copy.menuImage
            self.confirmation = nil
        }
    }

    func reset() {
        generation = UUID()
        confirmation?.cancel(); confirmation = nil
        observation.stop()
        copy.image = PilotIcon.copy.menuImage
        rewind = nil; entryID = nil; source = ""
        reveal(false)
    }
}

final class NativeUserMessage: NSView, NativeRowContent {
    private let bubble = NativeBubbleSurface()
    let message = NativeMarkdownMessage()
    private let preview = NSTextField(wrappingLabelWithString: "")
    private let folded = NativeTranscriptButton()
    private let chevron = NSImageView()
    private let less = NativeTranscriptButton("Show less", icon: PilotIcon.collapse)
    private let fullCopy = NativeTranscriptButton(icon: PilotIcon.copy)
    private let actions = NativeMessageActions()
    private let previewMask = CAGradientLayer()
    private let observation = NativeRowObservation()
    private var row: ChatRow?
    private var context: NativeRowContext?
    private var expansion: ExpansionState?
    private var source = ""
    private var timestamp: Double?
    private var previewValue = MessagePreview("")
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        message.showsActions = false
        preview.textColor = NSColor(Theme.foreground)
        preview.maximumNumberOfLines = MessagePreview.visibleLineLimit
        preview.wantsLayer = true
        previewMask.startPoint = CGPoint(x: 0.5, y: 1)
        previewMask.endPoint = CGPoint(x: 0.5, y: 0)
        previewMask.colors = [NSColor.black.cgColor, NSColor.black.cgColor, NSColor.clear.cgColor]
        previewMask.locations = [0, 0.63, 1]
        preview.layer?.mask = previewMask
        folded.setAccessibilityLabel("Expand message")
        folded.toolTip = "Click to show the full message"
        chevron.image = PilotIcon.disclosureOpen.menuImage
        chevron.contentTintColor = NSColor(Theme.mutedForeground)
        chevron.setAccessibilityElement(false)
        folded.onPress = { [weak self] in self?.toggle() }
        less.onPress = { [weak self] in self?.toggle() }
        fullCopy.onPress = { [weak self] in if let self { MessageCopyButton.copy(self.source) } }
        fullCopy.toolTip = "Copy full message"; fullCopy.setAccessibilityLabel("Copy full message")
        for view in [bubble, message, preview, chevron, folded, less, fullCopy, actions] { addSubview(view) }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func bind(_ row: ChatRow, context: NativeRowContext) {
        guard case let .user(_, text, timestamp) = row else { return }
        if self.row?.id != row.id {
            message.resetMessageBinding()
            actions.reset()
        }
        self.row = row; self.context = context; source = text; self.timestamp = timestamp
        previewValue = MessagePreview(text)
        expansion = context.messageExpansions.state(for: row.id)
        observation.bind(expansion.map { [$0.objectWillChange] } ?? []) { [weak self] in
            self?.rebuild()
            self?.context?.changed()
        }
        rebuild()
    }

    private func rebuild() {
        guard let context, let row else { return }
        let collapsed = previewValue.isLong && expansion?.expanded != true
        let expanded = previewValue.isLong && !collapsed
        message.isHidden = collapsed
        preview.isHidden = !collapsed; folded.isHidden = !collapsed; chevron.isHidden = !collapsed
        less.isHidden = !expanded; fullCopy.isHidden = !expanded
        if collapsed {
            message.stop()
            preview.font = context.environment.pilotFonts.nsBody
            let style = MessageSelectionTextView.Style(font: context.environment.pilotFonts.nsBody,
                mono: context.environment.pilotFonts.nsMono, color: NSColor(Theme.foreground), spacing: 5)
            preview.attributedStringValue = SelectableMessageText.attributed(
                AttributedString(previewValue.text.isEmpty ? "Long message" : previewValue.text), style: style)
        } else {
            if message.superview == nil { addSubview(message, positioned: .above, relativeTo: bubble) }
            var environment = context.environment
            environment.nativeTranscriptMenu = nativeMessageMenu(row: row, environment: environment)
            message.update(source: source, timestamp: nil, streaming: false, selection: context.selection(row.id),
                           environment: environment, changed: { [weak self] in self?.context?.changed() })
        }
        actions.update(source: source, timestamp: timestamp, entryID: row.entryID, environment: context.environment)
        setAccessibilityLabel("User message")
        var custom = [NSAccessibilityCustomAction(name: "Copy message", handler: { [weak self] in
            guard let self else { return false }; MessageCopyButton.copy(self.source); return true
        })]
        if let entry = row.entryID, let rewind = context.environment.transcriptRewind {
            custom.append(NSAccessibilityCustomAction(name: "Edit and Resend", handler: { [weak rewind] in
                guard let rewind, !rewind.pending else { return false }
                rewind.request(.edit, entryID: entry); return true
            }))
        }
        if previewValue.isLong {
            custom.append(NSAccessibilityCustomAction(name: collapsed ? "Expand message" : "Show less",
                                                      handler: { [weak self] in self?.toggle(); return self != nil }))
        }
        setAccessibilityCustomActions(custom)
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        guard let context else { return 1 }
        let available = max(1, width - 72 - 28)
        let collapsed = previewValue.isLong && expansion?.expanded != true
        let bodyWidth = collapsed ? available : message.preferredWidth(upTo: available)
        let bubbleWidth = bodyWidth + 28
        let x = max(0, width - bubbleWidth)
        let bodyHeight: CGFloat
        if collapsed {
            let font = context.environment.pilotFonts.nsBody
            bodyHeight = ceil(font.ascender - font.descender + font.leading + 5) * CGFloat(MessagePreview.visibleLineLimit)
        } else { bodyHeight = message.measure(width: bodyWidth) }
        let expanded = previewValue.isLong && !collapsed
        let extra: CGFloat = expanded ? 28 : 0
        let surfaceHeight = bodyHeight + (collapsed ? 14 : 20) + extra
        bubble.frame = NSRect(x: x, y: 6, width: bubbleWidth, height: surfaceHeight)
        let content = NSRect(x: x + 14, y: 16, width: bodyWidth, height: bodyHeight)
        preview.frame = content
        message.frame = content
        CATransaction.begin(); CATransaction.setDisableActions(true)
        previewMask.frame = preview.bounds
        CATransaction.commit()
        less.frame = NSRect(x: x + 14, y: 16 + bodyHeight + 8, width: 84, height: 20)
        fullCopy.frame = NSRect(x: x + 110, y: 16 + bodyHeight + 8, width: 24, height: 20)
        let foldHeight: CGFloat = collapsed ? 24 : 0
        chevron.frame = NSRect(x: x + (bubbleWidth - 14) / 2, y: 6 + surfaceHeight + 6, width: 14, height: 14)
        folded.frame = NSRect(x: x, y: 6, width: bubbleWidth, height: surfaceHeight + foldHeight)
        actions.frame = NSRect(x: 0, y: 6 + surfaceHeight + foldHeight + 4, width: width, height: 20)
        return ceil(6 + surfaceHeight + foldHeight + 24)
    }

    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }

    private func toggle() {
        context?.environment.transcriptMessageToggled?()
        expansion?.toggleExpanded()
    }

    func activate() -> Bool {
        guard previewValue.isLong else { return false }
        toggle(); return true
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        nativeMenuAction(menu, "Copy full message", icon: PilotIcon.copy) { [weak self] in
            if let self { MessageCopyButton.copy(self.source) }
        }
        if let row, let context { nativeMessageMenu(row: row, environment: context.environment)(menu) }
        return menu
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        tracking = area; addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { actions.reveal(true) }
    override func mouseExited(with event: NSEvent) { actions.reveal(false) }

    func stop() {
        observation.stop(); actions.reset(); message.stop()
        context = nil; row = nil; expansion = nil; source = ""
        removeFromSuperview()
    }
}

private final class NativeBubbleSurface: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = Theme.Radius.bubble
        setAccessibilityElement(false)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = NSColor(Theme.muted).cgColor }
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
