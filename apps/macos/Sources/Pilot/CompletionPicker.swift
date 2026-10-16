import AppKit
import PilotCore
import SwiftUI

/// One row of a composer completion menu: a path or a slash command.
struct CompletionItem: Identifiable, Equatable {
    let id: String
    let title: String
    /// Muted text right after the title, such as a folder's "/" or a command's arguments.
    var suffix: String?
    /// Muted, truncated description after the title.
    var detail: String?
    let icon: PilotIcon
    let tint: Color
    var help: String
    var accessibilityLabel: String
    var accessibilityHint: String

    static func path(_ candidate: String) -> CompletionItem {
        let directory = candidate.hasSuffix("/")
        let path = directory ? String(candidate.dropLast()) : candidate
        let name = (path as NSString).lastPathComponent.replacingOccurrences(of: "\\ ", with: " ")
        return CompletionItem(
            id: candidate, title: name, suffix: directory ? "/" : nil,
            icon: directory ? PilotIcon.project : PilotIcon.document,
            tint: Theme.mutedForeground,
            help: candidate, accessibilityLabel: "\(name), \(directory ? "folder" : "file")",
            accessibilityHint: "Insert this path"
        )
    }

    static func command(_ command: SlashCommand) -> CompletionItem {
        let icon: PilotIcon
        let tint: Color
        let kind: String
        switch command.kind {
        case .builtin: (icon, tint, kind) = (PilotIcon.command, Theme.mutedForeground, "Pilot command")
        case .app: (icon, tint, kind) = (PilotIcon.command, Theme.mutedForeground, "Opens in Pilot")
        case .prompt: (icon, tint, kind) = (PilotIcon.update, Theme.mutedForeground, "Prompt template")
        case .skill: (icon, tint, kind) = (PilotIcon.skill, Theme.mutedForeground, "Skill")
        }
        let detail = command.description?.split(whereSeparator: \.isNewline).first.map(String.init)
        return CompletionItem(
            id: command.name, title: command.invocation, suffix: command.argumentHint, detail: detail,
            icon: icon, tint: tint,
            help: [command.invocation, command.description].compactMap { $0 }.joined(separator: "\n"),
            accessibilityLabel: [command.invocation, kind, detail].compactMap { $0 }.joined(separator: ", "),
            accessibilityHint: "Insert this command"
        )
    }
}

@MainActor
final class CompletionPickerModel: ObservableObject {
    @Published private(set) var items: [CompletionItem]
    @Published var selected = 0
    var choose: ((Int) -> Void)?

    init(items: [CompletionItem]) {
        self.items = items
    }

    /// Keeps the selection on the same item when it is still listed.
    func replace(_ items: [CompletionItem]) {
        guard items != self.items else { return }
        let current = self.items.indices.contains(selected) ? self.items[selected].id : nil
        self.items = items
        selected = current.flatMap { id in items.firstIndex { $0.id == id } } ?? 0
    }

    func move(_ offset: Int) {
        guard !items.isEmpty else { return }
        selected = (selected + offset + items.count) % items.count
    }
}

private enum CompletionPickerMetrics {
    static let rowHeight: CGFloat = 40
    // Keyboard footer, list padding, and space for the card's shadow.
    static let chromeHeight: CGFloat = 64
}

private final class CompletionPickerPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// A non-activating panel keeps typing and keyboard navigation in the composer.
@MainActor
final class CompletionPicker {
    struct Hint: Equatable {
        let key: String
        let label: String
    }

    let model: CompletionPickerModel
    /// Text position the panel aligns with. Defaults to the caret; a fixed anchor keeps the panel still while typing.
    var anchor: Int?
    private let width: CGFloat
    private let hints: [Hint]
    private var panel: NSPanel?
    private var hosting: NSHostingView<CompletionPickerView>?
    private var clickMonitor: Any?
    private var resignObserver: NSObjectProtocol?
    private let onDismiss: () -> Void

    init(items: [CompletionItem], width: CGFloat = 360, hints: [Hint] = [Hint(key: "⇥ / ↩", label: "insert")],
         onChoose: @escaping (Int) -> Void, onDismiss: @escaping () -> Void) {
        model = CompletionPickerModel(items: items)
        model.choose = onChoose
        self.width = width
        self.hints = hints
        self.onDismiss = onDismiss
    }

    deinit { MainActor.assumeIsolated { close() } }

    static func frame(caret: CGRect, screen: CGRect, count: Int, width: CGFloat = 360) -> CGRect {
        let visible = screen.insetBy(dx: 12, dy: 12)
        let height = CGFloat(min(count, 6)) * CompletionPickerMetrics.rowHeight + CompletionPickerMetrics.chromeHeight
        let size = CGSize(width: min(width, visible.width), height: min(height, visible.height))
        let x = min(max(caret.minX - 12, visible.minX), visible.maxX - size.width)
        let below = caret.minY - size.height - 4
        let preferred = below >= visible.minY ? below : caret.maxY + 4
        let y = max(visible.minY, min(preferred, visible.maxY - size.height))
        return CGRect(origin: CGPoint(x: x, y: y), size: size)
    }

    var isVisible: Bool { panel != nil }

    func show(for editor: NSTextView) {
        guard let parent = editor.window, let frame = frame(for: editor) else { return }
        let panel = CompletionPickerPanel(contentRect: frame,
                                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        let hosting = NSHostingView(rootView: view(height: frame.height))
        panel.contentView = hosting
        parent.addChildWindow(panel, ordered: .above)
        panel.orderFront(nil)
        self.panel = panel
        self.hosting = hosting
        clickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .scrollWheel]) { [weak self, weak panel] event in
            if event.window !== panel { self?.onDismiss() }
            return event
        }
        resignObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: parent, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onDismiss() }
        }
    }

    /// Replace the listed items in place, resizing and repositioning the existing panel.
    func update(_ items: [CompletionItem], for editor: NSTextView) {
        model.replace(items)
        guard let panel, let frame = frame(for: editor), frame != panel.frame else { return }
        hosting?.rootView = view(height: frame.height)
        panel.setFrame(frame, display: true)
    }

    func close() {
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
        clickMonitor = nil
        resignObserver = nil
        if let panel {
            panel.parent?.removeChildWindow(panel)
            panel.close()
        }
        panel = nil
        hosting = nil
    }

    private func frame(for editor: NSTextView) -> CGRect? {
        guard let screen = editor.window?.screen else { return nil }
        let range = anchor.map { NSRange(location: $0, length: 0) } ?? editor.selectedRange()
        let caret = editor.firstRect(forCharacterRange: range, actualRange: nil)
        return Self.frame(caret: caret, screen: screen.visibleFrame, count: model.items.count, width: width)
    }

    private func view(height: CGFloat) -> CompletionPickerView {
        CompletionPickerView(model: model, hints: hints,
                             listHeight: max(0, height - CompletionPickerMetrics.chromeHeight))
    }
}

private struct CompletionPickerView: View {
    @ObservedObject var model: CompletionPickerModel
    let hints: [CompletionPicker.Hint]
    let listHeight: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(model.items.indices, id: \.self) { index in
                            row(index).id(index)
                        }
                    }
                    .padding(.horizontal, 6)
                }
                .frame(height: listHeight)
                .onChange(of: model.selected) { _, value in proxy.scrollTo(value) }
            }
            .padding(.vertical, 6)
            HStack(spacing: 12) {
                key("↑↓", "navigate")
                ForEach(hints, id: \.key) { key($0.key, $0.label) }
                Spacer()
                key("esc", "close")
            }
            .padding(.horizontal, 14).frame(height: 32)
            .background(Theme.sidebar)
            .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
        }
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.tray))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.tray).strokeBorder(Theme.border))
        .shadow(color: .black.opacity(0.13), radius: 9, y: 3)
        .padding(10)
    }

    private func row(_ index: Int) -> some View {
        let item = model.items[index]
        let selected = index == model.selected
        return Button {
            model.choose?(index)
        } label: {
            HStack(spacing: 10) {
                PilotSymbol(item.icon, context: .row).foregroundStyle(item.tint)
                    .frame(width: 18)
                Text(item.title).font(.pilot(.body, weight: selected ? .medium : .regular))
                    .foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.middle)
                    .layoutPriority(2)
                if let suffix = item.suffix {
                    Text(suffix).font(.pilot(.body)).foregroundStyle(Theme.faintForeground).lineLimit(1)
                        .layoutPriority(1)
                }
                if let detail = item.detail {
                    Text(detail).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                        .lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 4)
            }
            .padding(.horizontal, 10).frame(height: 34)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.selected)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
        }
        .buttonStyle(.plain)
        .frame(height: CompletionPickerMetrics.rowHeight)
        .onHover { if $0 { model.selected = index } }
        .help(item.help)
        .accessibilityLabel(item.accessibilityLabel)
        .accessibilityHint(item.accessibilityHint)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func key(_ symbol: String, _ label: String) -> some View {
        KeyHint(key: symbol, label: label)
    }
}
