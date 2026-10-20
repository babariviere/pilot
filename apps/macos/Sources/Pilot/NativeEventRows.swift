import AppKit
import PilotCore
import SwiftUI

/// Native event chrome and optional Markdown detail. Automatic input never becomes a user bubble.
final class NativeEventRow: NSView, NativeRowContent {
    private let icon = NSImageView()
    private let sentence = NSTextField(labelWithString: "")
    private let branch = NSTextField(labelWithString: "")
    private let title = NSTextField(labelWithString: "")
    private let time = NSTextField(labelWithString: "")
    private let show = NativeTranscriptButton()
    private let open = NativeTranscriptButton("Open")
    private let detail = NativeMarkdownMessage()
    private let observation = NativeRowObservation()
    private var event: ChatEvent?
    private var rowID = ""
    private var context: NativeRowContext?
    private var expansion: ExpansionState?
    private var openAction: (() -> Void)?
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        detail.showsActions = false
        for field in [sentence, branch, title] {
            field.font = .systemFont(ofSize: Theme.TextRole.label.size)
            field.textColor = NSColor(Theme.mutedForeground)
            field.lineBreakMode = .byTruncatingTail
            field.usesSingleLineMode = true
        }
        title.textColor = NSColor(Theme.faintForeground)
        branch.font = .monospacedSystemFont(ofSize: Theme.TextRole.caption.size, weight: .regular)
        branch.lineBreakMode = .byTruncatingMiddle
        time.font = .systemFont(ofSize: Theme.TextRole.caption.size)
        time.textColor = NSColor(Theme.faintForeground)
        time.alphaValue = 0
        time.setAccessibilityElement(false)
        icon.setAccessibilityElement(false)
        show.contentTintColor = NSColor(Theme.info)
        open.contentTintColor = NSColor(Theme.info)
        show.onPress = { [weak self] in
            self?.context?.environment.transcriptMessageToggled?()
            self?.expansion?.expanded.toggle()
        }
        open.onPress = { [weak self] in self?.openAction?() }
        for view in [icon, sentence, branch, title, show, open, time, detail] { addSubview(view) }
        setAccessibilityElement(true); setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func bind(_ row: ChatRow, context: NativeRowContext) {
        if rowID != row.id { detail.resetMessageBinding(); time.alphaValue = 0 }
        self.context = context
        rowID = row.id
        openAction = nil
        switch row {
        case let .user(id, text, timestamp):
            guard let notification = SubagentNotification(message: text) else { return }
            event = .subagent(id: id, notification: notification, timestamp: timestamp)
            setOpen(notification.name, context: context)
        case let .automatic(id, text, origin, timestamp):
            if let notification = SubagentNotification(message: text) {
                event = .subagent(id: id, notification: notification, timestamp: timestamp)
                setOpen(notification.name, context: context)
            } else { event = .automatic(id: id, text: text, origin: origin, timestamp: timestamp) }
        case let .question(id, question): event = .question(id: id, question: question)
        case let .notice(id, text): event = ChatEvent(id: id, kind: "activity", text: text)
        case let .event(value): event = value
        default: return
        }
        expansion = context.messageExpansions.state(for: row.id)
        observation.bind(expansion.map { [$0.objectWillChange] } ?? []) { [weak self] in
            self?.rebuild(); self?.context?.changed()
        }
        rebuild()
    }

    private func setOpen(_ name: String, context: NativeRowContext) {
        let resource = context.resource
        let session = resource.host.map {
            $0 == AppModel.shared.localHost ? resource.sessionID
                : HostResourceRef(host: $0, kind: .session, localId: resource.sessionID).storageKey
        } ?? resource.sessionID
        open.toolTip = "Open \(name)'s transcript in the Agents tab"
        openAction = { AppModel.shared.openSubagent(name, in: session) }
    }

    private func rebuild() {
        guard let event, let context else { return }
        sentence.stringValue = event.sentence
        sentence.textColor = NSColor(event.destructive ? Theme.foreground : Theme.mutedForeground)
        branch.stringValue = event.branch ?? ""; branch.isHidden = event.branch == nil
        title.stringValue = event.title ?? ""; title.isHidden = event.title == nil
        icon.image = (event.destructive ? PilotIcon.warning : eventIcon(event.kind)).menuImage
        icon.contentTintColor = NSColor(event.destructive ? Theme.destructive : Theme.mutedForeground)
        icon.setAccessibilityElement(event.destructive)
        icon.setAccessibilityLabel(event.destructive ? "Failed" : nil)
        time.stringValue = Self.timeLabel(event)
        show.title = expansion?.expanded == true ? "Hide" : "Show"
        show.setAccessibilityLabel(expansion?.expanded == true ? "Hide event details" : "Show event details")
        show.setAccessibilityValue(expansion?.expanded == true ? "Expanded" : "Collapsed")
        show.isHidden = event.detail == nil
        open.isHidden = openAction == nil
        toolTip = [event.sentence, event.branch, event.title, event.uncertainty].compactMap { $0 }.joined(separator: " ")
        if expansion?.expanded == true, let source = event.detail {
            detail.isHidden = false
            if detail.superview == nil { addSubview(detail) }
            detail.update(source: source, timestamp: nil, streaming: false, selection: context.selection(rowID),
                          environment: context.environment, changed: { [weak self] in self?.context?.changed() })
        } else { detail.stop() }
        setAccessibilityLabel(event.kind == "question" ? "Question" : "Timeline event")
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        guard let event else { return 1 }
        let line: CGFloat = 22
        icon.frame = NSRect(x: 0, y: 3, width: 12, height: 14)
        var right = width
        func trailing(_ view: NSView, _ requested: CGFloat) {
            let size = min(max(0, right - 21), requested)
            right -= size; view.frame = NSRect(x: right, y: 1, width: size, height: 20); right -= 7
        }
        if !time.stringValue.isEmpty { trailing(time, ceil(time.intrinsicContentSize.width)) }
        if !open.isHidden { trailing(open, 34) }
        if !show.isHidden { trailing(show, 34) }
        let available = max(0, right - 21)
        let sentenceWidth = min(available, ceil(sentence.intrinsicContentSize.width))
        sentence.frame = NSRect(x: 19, y: 2, width: sentenceWidth, height: 20)
        var x = 19 + sentenceWidth + 7
        if event.branch != nil {
            let size = min(max(0, right - x), min(180, ceil(branch.intrinsicContentSize.width)))
            branch.frame = NSRect(x: x, y: 2, width: size, height: 20); x += size + 7
        }
        if event.title != nil { title.frame = NSRect(x: x, y: 2, width: max(0, right - x), height: 20) }
        if expansion?.expanded == true, event.detail != nil {
            let height = detail.measure(width: max(1, width - 19))
            detail.frame = NSRect(x: 19, y: line + 8, width: max(1, width - 19), height: height)
            return line + 8 + height
        }
        return line
    }

    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }

    func activate() -> Bool {
        if event?.detail != nil {
            context?.environment.transcriptMessageToggled?()
            expansion?.expanded.toggle()
            return true
        }
        guard let openAction else { return false }
        openAction(); return true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        tracking = area; addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { time.alphaValue = 1 }
    override func mouseExited(with event: NSEvent) { time.alphaValue = 0 }

    func stop() {
        observation.stop(); detail.stop()
        context = nil; event = nil; expansion = nil; openAction = nil; time.alphaValue = 0
        removeFromSuperview()
    }

    private static func timeLabel(_ event: ChatEvent) -> String {
        guard let timestamp = event.timestamp else { return "" }
        let start = Date(timeIntervalSince1970: timestamp / 1000).formatted(date: .omitted, time: .shortened)
        guard let end = event.endTimestamp else { return start }
        return start + " to " + Date(timeIntervalSince1970: end / 1000).formatted(date: .omitted, time: .shortened)
    }

    private func eventIcon(_ kind: String) -> PilotIcon {
        switch kind {
        case "push": PilotIcon.push
        case "pr_opened", "pr_ready", "pr_draft", "pr_edited", "pr_reopened", "pr_follow_up": PilotIcon.pullRequest
        case "pi.compaction": PilotIcon.compaction
        case "pi.reset": PilotIcon.reset
        case "stopped": PilotIcon.stopped
        case "mission_updated", "mission_decisions_changed", "mission_task_done", "mission_member_finished": PilotIcon.mission
        case "job_finished", "job_failed": PilotIcon.terminal
        case "subagent_answered", "subagent_failed", "subagent_message": PilotIcon.subagents
        case "coordinator_message": PilotIcon.coordinator
        case "automatic_message": PilotIcon.extensionTool
        case "slack_reply": PilotIcon.message
        case "question": PilotIcon.question
        default: PilotIcon.unset
        }
    }
}

final class NativeErrorRow: NSView, NativeRowContent {
    private let text = MessageSelectionTextView.makeReadOnly()
    private let icon = NSImageView()
    private let retry = NativeTranscriptButton("Retry", icon: PilotIcon.refresh)
    private let observation = NativeRowObservation()
    private var context: NativeRowContext?
    private var entry: Int?
    private var source = ""
    private var rowID = ""
    private var hasRetry = false
    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true; layer?.cornerRadius = Theme.Radius.control
        icon.image = PilotIcon.warning.menuImage
        icon.contentTintColor = NSColor(Theme.error)
        icon.setAccessibilityElement(false)
        retry.onPress = { [weak self] in
            guard let self, let entry = self.entry, let rewind = self.context?.environment.transcriptRewind,
                  !rewind.pending, rewind.retryEntryID == entry else { return }
            rewind.request(.retry, entryID: entry)
        }
        retry.setAccessibilityLabel("Retry failed turn")
        for view in [icon, text, retry] { addSubview(view) }
        setAccessibilityElement(true); setAccessibilityRole(.group); setAccessibilityLabel("Error")
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func bind(_ row: ChatRow, context: NativeRowContext) {
        guard case let .error(_, source) = row else { return }
        if rowID != row.id { text.setSelectedRange(NSRange(location: 0, length: 0)) }
        rowID = row.id
        self.context = context; entry = row.entryID; self.source = source
        text.textStorage?.setAttributedString(NSAttributedString(string: source, attributes: [
            .font: NSFont.systemFont(ofSize: Theme.TextRole.body.size), .foregroundColor: NSColor(Theme.error),
        ]))
        text.invalidateMeasurements()
        let rewind = context.environment.transcriptRewind
        observation.bind(rewind.map { [$0.objectWillChange] } ?? []) { [weak self] in
            self?.refreshRetry(); self?.context?.changed()
        }
        refreshRetry()
    }

    private func refreshRetry() {
        let rewind = context?.environment.transcriptRewind
        hasRetry = entry != nil && rewind?.retryEntryID == entry
        retry.isHidden = !hasRetry
        retry.isEnabled = rewind?.pending != true
        needsLayout = true
    }

    func measure(width: CGFloat) -> CGFloat {
        let reserve: CGFloat = hasRetry ? 70 : 0
        let textWidth = max(1, width - 44 - reserve)
        let size = text.measure(width: textWidth, unwrapped: false)
        text.frame = NSRect(x: 34, y: 10, width: textWidth, height: size.height)
        icon.frame = NSRect(x: 10, y: 12, width: 14, height: 14)
        retry.frame = NSRect(x: max(0, width - 70), y: 10, width: 60, height: 20)
        return max(size.height, hasRetry ? 20 : 0) + 20
    }
    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor(Theme.destructive).withAlphaComponent(0.1).cgColor
        }
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    func stop() { observation.stop(); context = nil; source = ""; removeFromSuperview() }
}
