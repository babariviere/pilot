import AppKit
import PilotCore
import SwiftUI

struct NativeChromeAction {
    let title: String
    var icon: PilotIcon? = nil
    var identifier: String? = nil
    var help: String? = nil
    var enabled = true
    let perform: () -> Void
}

struct NativeTranscriptBanner {
    let title: String
    var detail: String? = nil
    var meta: String? = nil
    var icon: PilotIcon? = nil
    var action: NativeChromeAction? = nil
}

struct NativeTranscriptHeader {
    var banners: [NativeTranscriptBanner] = []
    var disconnected: HostViewContext? = nil
    var historyCached = true
    var loading: String? = nil

    @MainActor var disconnectionBanner: NativeTranscriptBanner? {
        guard let disconnected else { return nil }
        let message = DisconnectedHistoryMessage(context: disconnected, historyCached: historyCached)
        return NativeTranscriptBanner(title: message.title,
            detail: [message.detail, message.ownership].compactMap { $0 }.joined(separator: "\n"))
    }
}

struct NativeTranscriptFooter {
    struct Pending: Identifiable {
        let id: String
        let text: String
    }
    var pending: [Pending] = []
    var failure: String? = nil
    var actions: [NativeChromeAction] = []
    var scheduleSessionID: String? = nil
    var bottomPadding: CGFloat = 0
    var review: () -> Void = {}
}

class NativeTranscriptChrome: NSView {
    override var isFlipped: Bool { true }
    func measure(width: CGFloat) -> CGFloat { 1 }
    func stop() { removeFromSuperview() }
    func activate() -> Bool { false }
}

private func chromeLabelHeight(_ label: NSTextField, width: CGFloat) -> CGFloat {
    ceil(label.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: max(1, width), height: 1_000_000)).height
         ?? label.intrinsicContentSize.height)
}

private final class NativeBanner: NSView {
    private let icon = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let meta = NSTextField(labelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let action = NativeTranscriptButton()
    private var value: NativeTranscriptBanner?
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        title.font = .systemFont(ofSize: Theme.TextRole.body.size, weight: .semibold)
        title.textColor = NSColor(Theme.foreground)
        title.lineBreakMode = .byTruncatingTail
        meta.font = .systemFont(ofSize: Theme.TextRole.caption.size); meta.textColor = NSColor(Theme.faintForeground)
        detail.font = .systemFont(ofSize: Theme.TextRole.label.size); detail.textColor = NSColor(Theme.mutedForeground)
        icon.contentTintColor = NSColor(Theme.mutedForeground); icon.setAccessibilityElement(false)
        for view in [icon, title, meta, detail, action] { addSubview(view) }
        setAccessibilityElement(true); setAccessibilityRole(.group)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    func update(_ value: NativeTranscriptBanner) {
        self.value = value
        let linkOnly = value.title.isEmpty && value.detail == nil
        title.isHidden = linkOnly
        title.stringValue = value.title
        meta.stringValue = value.meta ?? ""; meta.isHidden = value.meta == nil
        detail.stringValue = value.detail ?? ""; detail.isHidden = value.detail == nil
        icon.image = value.icon?.menuImage; icon.isHidden = value.icon == nil || linkOnly
        action.isHidden = value.action == nil
        if let button = value.action {
            action.title = button.title
            action.image = button.icon?.menuImage
            action.contentTintColor = NSColor(linkOnly ? Theme.info : Theme.mutedForeground)
            action.onPress = button.perform
            action.isEnabled = button.enabled
            action.toolTip = button.help
            action.setAccessibilityIdentifier(button.identifier)
        }
        needsLayout = true
    }
    func measure(width: CGFloat) -> CGFloat {
        guard let value else { return 0 }
        if value.title.isEmpty, value.detail == nil {
            action.frame = NSRect(x: 0, y: 0, width: min(width, ceil(action.intrinsicContentSize.width) + 12), height: 22)
            return 22
        }
        let indent: CGFloat = value.icon == nil ? 0 : 22
        let actionWidth: CGFloat = value.action == nil ? 0 : min(width * 0.45, max(76, action.intrinsicContentSize.width + 12))
        let contentWidth = max(1, width - indent - (actionWidth > 0 ? actionWidth + 8 : 0))
        let metaWidth = value.meta == nil ? 0 : min(contentWidth / 2, ceil(meta.intrinsicContentSize.width))
        let titleWidth = min(max(1, contentWidth - metaWidth - (metaWidth > 0 ? 6 : 0)), ceil(title.intrinsicContentSize.width))
        title.frame = NSRect(x: indent, y: 0, width: titleWidth, height: 20)
        meta.frame = NSRect(x: indent + titleWidth + 6, y: 2, width: metaWidth, height: 18)
        icon.frame = NSRect(x: 0, y: 2, width: 14, height: 16)
        var height: CGFloat = 20
        if value.detail != nil {
            let size = chromeLabelHeight(detail, width: contentWidth)
            detail.frame = NSRect(x: indent, y: 23, width: contentWidth, height: size)
            height += 3 + size
        }
        action.frame = NSRect(x: width - actionWidth, y: 0, width: actionWidth, height: 26)
        return max(height, value.action == nil ? 0 : 26)
    }
}

final class NativeHeaderChrome: NativeTranscriptChrome {
    private var banners: [NativeBanner] = []
    private let connection = NativeBanner()
    private let loading = NSTextField(labelWithString: "")
    private let spinner = EllipsisSpinnerView()
    private var value = NativeTranscriptHeader()
    override init(frame: NSRect) {
        super.init(frame: frame)
        loading.font = .systemFont(ofSize: Theme.TextRole.label.size)
        loading.textColor = NSColor(Theme.mutedForeground)
        for view in [connection, loading, spinner] { addSubview(view) }
        setAccessibilityElement(false)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    func update(_ value: NativeTranscriptHeader, context: NativeRowContext) {
        self.value = value
        while banners.count > value.banners.count { banners.removeLast().removeFromSuperview() }
        for (index, banner) in value.banners.enumerated() {
            if index == banners.count { let view = NativeBanner(); banners.append(view); addSubview(view) }
            banners[index].update(banner)
        }
        refreshConnection()
        loading.stringValue = value.loading ?? ""; loading.isHidden = value.loading == nil
        spinner.isHidden = value.loading == nil
        spinner.animates = value.loading != nil && !context.environment.accessibilityReduceMotion
        needsLayout = true
    }
    private func refreshConnection() {
        let banner = value.disconnectionBanner
        connection.isHidden = banner == nil
        if let banner { connection.update(banner) }
        needsLayout = true
    }
    override func measure(width: CGFloat) -> CGFloat {
        var y: CGFloat = 24
        for (index, banner) in banners.enumerated() {
            if index > 0 { y += 16 }
            let height = banner.measure(width: width)
            banner.frame = NSRect(x: 0, y: y, width: width, height: height); y += height
        }
        if value.disconnected != nil {
            if !banners.isEmpty { y += 16 }
            y += 8
            let height = connection.measure(width: width)
            connection.frame = NSRect(x: 0, y: y, width: width, height: height); y += height + 8
        }
        if value.loading != nil {
            if y > 24 { y += 16 }
            let labelWidth = min(max(1, width - 36), loading.intrinsicContentSize.width)
            loading.frame = NSRect(x: (width - labelWidth) / 2 + 10, y: y, width: labelWidth, height: 22)
            spinner.frame = NSRect(x: max(0, loading.frame.minX - 22), y: y + 3, width: 14, height: 14)
            y += 22
        }
        return y
    }
    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    override func stop() {
        spinner.animates = false; value = NativeTranscriptHeader()
        super.stop()
    }
}

final class NativeFooterChrome: NativeTranscriptChrome {
    private var pending: [String: NativeUserMessage] = [:]
    private var buttons: [NativeTranscriptButton] = []
    private var failure: NativeErrorRow?
    private var schedules: NativeScheduledMessages?
    private let review = ChatReviewVisibility.ReviewView()
    private var value = NativeTranscriptFooter()
    private var context: NativeRowContext?

    override init(frame: NSRect) { super.init(frame: frame); addSubview(review); setAccessibilityElement(false) }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    func update(_ value: NativeTranscriptFooter, context: NativeRowContext) {
        self.value = value; self.context = context
        let retained = Set(value.pending.map(\.id))
        for id in Array(pending.keys) where !retained.contains(id) { pending.removeValue(forKey: id)?.stop() }
        for item in value.pending {
            let view = pending[item.id] ?? NativeUserMessage()
            if pending[item.id] == nil { pending[item.id] = view; addSubview(view) }
            view.bind(.user(id: item.id, text: item.text), context: context)
        }
        if let error = value.failure {
            let view = failure ?? NativeErrorRow()
            if failure == nil { failure = view; addSubview(view) }
            view.bind(.error(id: "startup-error", text: error), context: context)
        } else { failure?.stop(); failure = nil }
        while buttons.count > value.actions.count { buttons.removeLast().removeFromSuperview() }
        for (index, action) in value.actions.enumerated() {
            if index == buttons.count { let view = NativeTranscriptButton(); buttons.append(view); addSubview(view) }
            let button = buttons[index]
            button.title = action.title; button.image = action.icon?.menuImage; button.imagePosition = .imageLeading
            button.isEnabled = action.enabled; button.onPress = action.perform; button.toolTip = action.help
            button.setAccessibilityIdentifier(action.identifier)
        }
        if let sessionID = value.scheduleSessionID {
            let view = schedules ?? NativeScheduledMessages()
            if schedules == nil { schedules = view; addSubview(view) }
            view.update(sessionID: sessionID, context: context)
        } else { schedules?.stop(); schedules = nil }
        review.onVisible = value.review; review.scheduleCheck()
        needsLayout = true
    }
    override func measure(width: CGFloat) -> CGFloat {
        var y: CGFloat = 0
        for item in value.pending {
            guard let view = pending[item.id] else { continue }
            if y > 0 { y += 16 }
            let height = view.measure(width: width)
            view.frame = NSRect(x: 0, y: y, width: width, height: height); y += height
        }
        if let failure {
            if y > 0 { y += 16 }
            let height = failure.measure(width: width)
            failure.frame = NSRect(x: 0, y: y, width: width, height: height); y += height
        }
        if !buttons.isEmpty {
            if y > 0 { y += 8 }
            var x: CGFloat = 0
            for button in buttons {
                let size = min(max(1, width - x), max(76, ceil(button.intrinsicContentSize.width) + 12))
                button.frame = NSRect(x: x, y: y, width: size, height: 24); x += size + 8
            }
            y += 24
        }
        if let schedules {
            let height = schedules.measure(width: width)
            schedules.frame = NSRect(x: 0, y: y + (height > 0 ? 16 : 0), width: width, height: height)
            if height > 0 { y += 16 + height }
        }
        review.frame = NSRect(x: 0, y: y, width: width, height: 1)
        return y + 1 + value.bottomPadding
    }
    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    override func stop() {
        for view in pending.values { view.stop() }; pending = [:]
        failure?.stop(); failure = nil; schedules?.stop(); schedules = nil
        review.onVisible = nil; review.stopObserving()
        value = NativeTranscriptFooter(); context = nil
        for button in buttons { button.onPress = nil }
        super.stop()
    }
}

final class NativeEarlierChrome: NativeTranscriptChrome {
    private let button = NativeTranscriptButton()
    private let spinner = EllipsisSpinnerView()
    private let error = NSTextField(wrappingLabelWithString: "")
    private let left = NativeChromeRule()
    private let right = NativeChromeRule()
    private var loading = false
    private var load: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        button.contentTintColor = NSColor(Theme.info)
        button.toolTip = "Show older messages without changing the agent's context."
        button.onPress = { [weak self] in if self?.loading == false { self?.load?() } }
        error.font = .systemFont(ofSize: Theme.TextRole.caption.size)
        error.textColor = NSColor(Theme.error); error.alignment = .center
        for view in [left, right, button, spinner, error] { addSubview(view) }
        setAccessibilityElement(false)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    func update(loading: Bool, error: String?, context: NativeRowContext, load: @escaping () -> Void) {
        self.loading = loading; self.load = load
        button.title = loading ? "Loading earlier messages…" : error == nil ? "Show earlier messages" : "Retry loading earlier messages"
        button.isEnabled = !loading
        spinner.isHidden = !loading; spinner.animates = loading && !context.environment.accessibilityReduceMotion
        self.error.stringValue = error ?? ""; self.error.isHidden = error == nil || loading
        needsLayout = true
    }
    override func measure(width: CGFloat) -> CGFloat {
        let label = min(max(1, width - 20), ceil(button.intrinsicContentSize.width) + (loading ? 22 : 0))
        let x = (width - label) / 2
        left.frame = NSRect(x: 0, y: 10, width: max(0, x - 8), height: 1)
        right.frame = NSRect(x: x + label + 8, y: 10, width: max(0, x - 8), height: 1)
        button.frame = NSRect(x: x + (loading ? 22 : 0), y: 0, width: label - (loading ? 22 : 0), height: 22)
        spinner.frame = NSRect(x: x, y: 3, width: 14, height: 14)
        if !error.isHidden {
            let size = chromeLabelHeight(error, width: width)
            error.frame = NSRect(x: 0, y: 26, width: width, height: size)
            return 26 + size
        }
        return 22
    }
    override func layout() { super.layout(); _ = measure(width: max(1, bounds.width)) }
    override func activate() -> Bool { guard !loading else { return false }; load?(); return true }
    override func stop() { load = nil; spinner.animates = false; super.stop() }
}

private final class NativeChromeRule: NSView {
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true; setAccessibilityElement(false) }
    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = NSColor(Theme.border).cgColor }
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
