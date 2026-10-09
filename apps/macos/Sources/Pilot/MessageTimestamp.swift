import AppKit
import PilotCore
import SwiftUI

struct MessageTimestampKey: Equatable {
    let rowID: String
    let milliseconds: Double
}

/// One selection per chat. Targets are weak, so lazy rows can release their native views.
@MainActor
final class MessageTimestampSelection: ObservableObject {
    @Published private(set) var selected: MessageTimestampKey?
    private struct Target {
        weak var view: NSView?
        let key: MessageTimestampKey
    }
    private var targets: [ObjectIdentifier: Target] = [:]

    func toggle(_ key: MessageTimestampKey) { selected = selected == key ? nil : key }
    func dismiss() { selected = nil }

    func register(_ view: NSView, key: MessageTimestampKey) {
        targets[ObjectIdentifier(view)] = Target(view: view, key: key)
    }

    func unregister(_ view: NSView) { targets.removeValue(forKey: ObjectIdentifier(view)) }

    func target(at point: NSPoint, in window: NSWindow) -> MessageTimestampKey? {
        targets.values.first { target in
            guard let view = target.view, view.window === window else { return false }
            // Unclipped NSViews can report a visibleRect larger than their own bounds.
            // Intersect both so a bubble cannot claim clicks elsewhere in the window.
            return view.bounds.intersection(view.visibleRect).contains(view.convert(point, from: nil))
        }?.key
    }
}

private struct MessageTimestampSelectionKey: EnvironmentKey {
    static let defaultValue: MessageTimestampSelection? = nil
}

extension EnvironmentValues {
    var messageTimestampSelection: MessageTimestampSelection? {
        get { self[MessageTimestampSelectionKey.self] }
        set { self[MessageTimestampSelectionKey.self] = newValue }
    }
}

/// Wrap only the bubble, not its leading spacer, so clicking empty space dismisses.
struct MessageTimestamp<Content: View>: View {
    let rowID: String
    let milliseconds: Double?
    var trailing = false
    @ViewBuilder let content: () -> Content
    @Environment(\.messageTimestampSelection) private var selection

    var body: some View {
        if let selection, let milliseconds, MessageTimeFormatting.date(milliseconds) != nil {
            TimestampedMessage(key: MessageTimestampKey(rowID: rowID, milliseconds: milliseconds),
                               trailing: trailing, selection: selection, content: content)
        } else {
            content()
        }
    }
}

private struct TimestampedMessage<Content: View>: View {
    let key: MessageTimestampKey
    let trailing: Bool
    @ObservedObject var selection: MessageTimestampSelection
    @ViewBuilder let content: () -> Content
    @Environment(\.transcriptMessageToggled) private var messageToggled

    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 5) {
            content()
            if selection.selected == key, let label = MessageTimeFormatting.label(key.milliseconds) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(Theme.mutedForeground)
                    .help(MessageTimeFormatting.detail(key.milliseconds) ?? label)
                    .accessibilityLabel(MessageTimeFormatting.detail(key.milliseconds) ?? label)
            }
        }
        .background(MessageTimestampTarget(key: key, selection: selection))
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: Text("Show or hide timestamp")) {
            messageToggled?()
            selection.toggle(key)
        }
    }
}

private struct MessageTimestampTarget: NSViewRepresentable {
    let key: MessageTimestampKey
    let selection: MessageTimestampSelection

    func makeNSView(context: Context) -> TargetView { TargetView(selection: selection) }
    func updateNSView(_ view: TargetView, context: Context) { selection.register(view, key: key) }
    static func dismantleNSView(_ view: TargetView, coordinator: ()) { view.selection?.unregister(view) }

    final class TargetView: NSView {
        weak var selection: MessageTimestampSelection?
        init(selection: MessageTimestampSelection) {
            self.selection = selection
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

/// Observe, never consume, native clicks. A drag/double-click still selects text, and nested
/// links, copy controls and folded-message buttons keep their normal event handling.
struct MessageTimestampClickObserver: NSViewRepresentable {
    let selection: MessageTimestampSelection
    let onToggle: () -> Void

    func makeNSView(context: Context) -> ObserverView { ObserverView(selection: selection, onToggle: onToggle) }
    func updateNSView(_ view: ObserverView, context: Context) { view.onToggle = onToggle }
    static func dismantleNSView(_ view: ObserverView, coordinator: ()) { view.stop() }

    final class ObserverView: NSView {
        let selection: MessageTimestampSelection
        var onToggle: () -> Void
        private var monitor: Any?
        private var mouseDown: NSPoint?
        private var mouseDownTarget: MessageTimestampKey?
        private var dragged = false

        init(selection: MessageTimestampSelection, onToggle: @escaping () -> Void) {
            self.selection = selection
            self.onToggle = onToggle
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stop()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] event in
                self?.observe(event)
                return event
            }
        }

        func stop() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            mouseDown = nil
            mouseDownTarget = nil
        }

        func observe(_ event: NSEvent) {
            guard let window, event.window === window, !isHiddenOrHasHiddenAncestor else {
                mouseDown = nil
                return
            }
            switch event.type {
            case .leftMouseDown:
                mouseDown = event.locationInWindow
                mouseDownTarget = selection.target(at: event.locationInWindow, in: window)
                dragged = event.clickCount != 1
            case .leftMouseDragged:
                dragged = true
            case .leftMouseUp:
                defer { mouseDown = nil; mouseDownTarget = nil }
                guard let mouseDown, !dragged, event.clickCount == 1,
                      hypot(event.locationInWindow.x - mouseDown.x, event.locationInWindow.y - mouseDown.y) < 4 else { return }
                let target = selection.target(at: event.locationInWindow, in: window)
                guard target == mouseDownTarget else { return }
                if let target {
                    onToggle()
                    selection.toggle(target)
                } else if selection.selected != nil {
                    onToggle()
                    selection.dismiss()
                }
            default: break
            }
        }
    }
}
