import AppKit
import Combine
import PilotCore
import SwiftUI

/// Schedule publications update only this footer subtree, never the transcript's history.
final class NativeScheduledMessages: NSView {
    private var client: PilotClient?
    private var context: NativeRowContext?
    private var sessionID = ""
    private var subscription: AnyCancellable?
    private let hosts = NativeRowObservation()
    private var items: [ScheduledItem] = []
    private var rows: [String: NativeScheduledBubble] = [:]
    override var isFlipped: Bool { true }

    func update(sessionID: String, context: NativeRowContext) {
        self.context = context
        let next = context.environment.hostViewContext.map { $0.hosts.presentationClient($0.host) } ?? AppModel.shared.client
        let rebound = client !== next || self.sessionID != sessionID
        self.sessionID = sessionID; client = next
        let owners = context.environment.hostViewContext?.hosts
        hosts.bind(owners.map { [$0.objectWillChange] } ?? []) { [weak self] in
            guard let self, let context = self.context else { return }
            self.update(sessionID: self.sessionID, context: context)
        }
        if rebound {
            subscription?.cancel()
            subscription = next.$schedules.sink { [weak self] all in
                self?.apply(ScheduleText.followUps(all, sessionId: sessionID))
            }
        }
        for item in items { rows[item.id]?.update(item, context: context, client: next) }
    }

    private func apply(_ items: [ScheduledItem]) {
        guard items.map(\.id) != self.items.map(\.id) || items.map(\.revision) != self.items.map(\.revision) else { return }
        self.items = items
        let retained = Set(items.map(\.id))
        for id in Array(rows.keys) where !retained.contains(id) { rows.removeValue(forKey: id)?.stop() }
        if let context, let client {
            for item in items {
                let view = rows[item.id] ?? NativeScheduledBubble()
                if rows[item.id] == nil { rows[item.id] = view; addSubview(view) }
                view.update(item, context: context, client: client)
            }
        }
        needsLayout = true; context?.changed()
    }

    func measure(width: CGFloat) -> CGFloat {
        var y: CGFloat = 0
        for (index, item) in items.enumerated() {
            guard let view = rows[item.id] else { continue }
            if index > 0 { y += 12 }
            let height = view.measure(width: width)
            view.frame = NSRect(x: 0, y: y, width: width, height: height); y += height
        }
        return y
    }
    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    func stop() {
        subscription?.cancel(); subscription = nil; hosts.stop()
        for row in rows.values { row.stop() }; rows = [:]; items = []
        context = nil; client = nil
        removeFromSuperview()
    }
}

private final class NativeScheduledBubble: NSView {
    private let surface = NativeScheduledOutline()
    private let text = NSTextField(wrappingLabelWithString: "")
    private let when = NSTextField(labelWithString: "")
    private let state = NSImageView()
    private let edit = NativeTranscriptButton(icon: PilotIcon.edit)
    private let cancel = NativeTranscriptButton(icon: PilotIcon.dismiss)
    private let tap = NativeTranscriptButton()
    private var item: ScheduledItem?
    private var context: NativeRowContext?
    private var client: PilotClient?
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        text.maximumNumberOfLines = 8
        text.lineBreakMode = .byTruncatingTail
        text.textColor = NSColor(Theme.mutedForeground)
        when.font = .systemFont(ofSize: Theme.TextRole.caption.size)
        when.textColor = NSColor(Theme.faintForeground)
        when.lineBreakMode = .byTruncatingTail
        state.setAccessibilityElement(false)
        edit.setAccessibilityLabel("Edit schedule"); edit.toolTip = "Edit when this message is sent"
        cancel.setAccessibilityLabel("Cancel schedule"); cancel.toolTip = "Cancel this scheduled message"
        tap.setAccessibilityLabel("Edit schedule")
        edit.onPress = { [weak self] in self?.open() }
        tap.onPress = { [weak self] in self?.open() }
        cancel.onPress = { [weak self] in self?.remove() }
        for view in [surface, text, tap, edit, cancel, state, when] { addSubview(view) }
        setAccessibilityElement(true); setAccessibilityRole(.group)
        edit.alphaValue = 0; cancel.alphaValue = 0
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func update(_ item: ScheduledItem, context: NativeRowContext, client: PilotClient) {
        if self.item?.id != item.id || self.client !== client {
            generation = UUID(); task?.cancel(); task = nil
            edit.alphaValue = 0; cancel.alphaValue = 0
        }
        self.item = item; self.context = context; self.client = client
        let body: String
        if case let .message(_, message) = item.target { body = message } else { body = item.title }
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 3
        text.attributedStringValue = NSAttributedString(string: body, attributes: [
            .font: context.environment.pilotFonts.nsBody, .foregroundColor: NSColor(Theme.mutedForeground), .paragraphStyle: paragraph,
        ])
        when.stringValue = "Scheduled · \(ScheduleText.when(item))"
        when.toolTip = "Sends \(ScheduleText.when(item))"
        state.image = item.state.icon.menuImage
        state.contentTintColor = NSColor(item.state.color)
        cancel.isEnabled = task == nil
        setAccessibilityLabel("Scheduled, \(ScheduleText.when(item)): \(body)")
        setAccessibilityCustomActions([
            NSAccessibilityCustomAction(name: "Edit schedule", handler: { [weak self] in self?.open(); return self != nil }),
            NSAccessibilityCustomAction(name: "Cancel schedule", handler: { [weak self] in self?.remove(); return self != nil }),
        ])
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        let available = max(1, width - 100)
        let natural = text.cell?.cellSize.width ?? available
        let contentWidth = min(available, max(1, natural))
        let textHeight = ceil(text.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: contentWidth, height: 1_000_000)).height ?? 20)
        let x = max(0, width - contentWidth - 28)
        surface.frame = NSRect(x: x, y: 0, width: contentWidth + 28, height: textHeight + 20)
        text.frame = NSRect(x: x + 14, y: 10, width: contentWidth, height: textHeight)
        tap.frame = surface.frame
        let footer = textHeight + 24
        let whenWidth = min(max(1, width - 80), ceil(when.intrinsicContentSize.width))
        when.frame = NSRect(x: width - whenWidth, y: footer + 2, width: whenWidth, height: 18)
        state.frame = NSRect(x: when.frame.minX - 18, y: footer + 3, width: 14, height: 14)
        cancel.frame = NSRect(x: state.frame.minX - 30, y: footer, width: 24, height: 20)
        edit.frame = NSRect(x: cancel.frame.minX - 26, y: footer, width: 24, height: 20)
        return footer + 20
    }
    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    private func open() {
        guard let item, let environment = context?.environment else { return }
        environment.nativeTranscriptPresent?(.init(content: .schedule(item), environment: environment))
    }
    private func remove() {
        guard task == nil, let item, let client else { return }
        let generation = generation
        cancel.isEnabled = false
        task = Task { [weak self] in
            do { try await client.deleteSchedule(item.id) }
            catch {
                guard !Task.isCancelled, let self, self.generation == generation, let window = self.window else { return }
                let alert = NSAlert()
                alert.messageText = "Couldn't cancel this schedule"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "OK")
                _ = await alert.beginSheetModal(for: window)
            }
            guard !Task.isCancelled, let self, self.generation == generation else { return }
            self.task = nil; self.cancel.isEnabled = true
        }
    }
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        nativeMenuAction(menu, "Edit Schedule…", icon: PilotIcon.edit) { [weak self] in self?.open() }
        menu.addItem(.separator())
        nativeMenuAction(menu, "Cancel Schedule", icon: PilotIcon.dismiss, enabled: task == nil) { [weak self] in self?.remove() }
        return menu
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        tracking = area; addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { edit.alphaValue = 1; cancel.alphaValue = 1 }
    override func mouseExited(with event: NSEvent) { edit.alphaValue = 0; cancel.alphaValue = 0 }
    func stop() {
        generation = UUID(); task?.cancel(); task = nil
        item = nil; context = nil; client = nil
        removeFromSuperview()
    }
}

private final class NativeScheduledOutline: NSView {
    override init(frame: NSRect) { super.init(frame: frame); setAccessibilityElement(false) }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(Theme.border).setStroke()
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                                xRadius: Theme.Radius.bubble, yRadius: Theme.Radius.bubble)
        path.lineWidth = 1; path.setLineDash([4, 3], count: 2, phase: 0); path.stroke()
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
