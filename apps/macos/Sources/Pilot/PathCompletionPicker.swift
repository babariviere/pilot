import AppKit
import SwiftUI

@MainActor
final class PathPickerModel: ObservableObject {
    let candidates: [String]
    @Published var selected = 0
    var choose: ((Int) -> Void)?

    init(candidates: [String]) {
        self.candidates = candidates
    }

    func move(_ offset: Int) {
        guard !candidates.isEmpty else { return }
        selected = (selected + offset + candidates.count) % candidates.count
    }
}

private enum PathPickerMetrics {
    static let rowHeight: CGFloat = 40
    // Keyboard footer, list padding, and space for the card's shadow.
    static let chromeHeight: CGFloat = 64
}

private final class PathPickerPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// A non-activating panel keeps typing and keyboard navigation in the composer.
@MainActor
final class PathCompletionPicker {
    let model: PathPickerModel
    private var panel: NSPanel?
    private var clickMonitor: Any?
    private var resignObserver: NSObjectProtocol?
    private let onDismiss: () -> Void

    init(candidates: [String], onChoose: @escaping (Int) -> Void, onDismiss: @escaping () -> Void) {
        model = PathPickerModel(candidates: candidates)
        model.choose = onChoose
        self.onDismiss = onDismiss
    }

    deinit { MainActor.assumeIsolated { close() } }

    static func frame(caret: CGRect, screen: CGRect, count: Int) -> CGRect {
        let visible = screen.insetBy(dx: 12, dy: 12)
        let height = CGFloat(min(count, 6)) * PathPickerMetrics.rowHeight + PathPickerMetrics.chromeHeight
        let size = CGSize(width: min(360, visible.width), height: min(height, visible.height))
        let x = min(max(caret.minX - 12, visible.minX), visible.maxX - size.width)
        let below = caret.minY - size.height - 4
        let preferred = below >= visible.minY ? below : caret.maxY + 4
        let y = max(visible.minY, min(preferred, visible.maxY - size.height))
        return CGRect(origin: CGPoint(x: x, y: y), size: size)
    }

    func show(for editor: NSTextView) {
        guard let parent = editor.window, let screen = parent.screen else { return }
        let caret = editor.firstRect(forCharacterRange: editor.selectedRange(), actualRange: nil)
        let frame = Self.frame(caret: caret, screen: screen.visibleFrame, count: model.candidates.count)
        let panel = PathPickerPanel(contentRect: frame,
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.contentView = NSHostingView(rootView: PathPickerView(model: model, listHeight: max(0, frame.height - PathPickerMetrics.chromeHeight)))
        parent.addChildWindow(panel, ordered: .above)
        panel.orderFront(nil)
        self.panel = panel
        clickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .scrollWheel]) { [weak self, weak panel] event in
            if event.window !== panel { self?.onDismiss() }
            return event
        }
        resignObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: parent, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onDismiss() }
        }
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
    }
}

private struct PathPickerView: View {
    @ObservedObject var model: PathPickerModel
    let listHeight: CGFloat
    private let accent = Color(hex: 0x6366F1)

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(model.candidates.indices, id: \.self) { index in
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
                key("⇥ / ↩", "insert")
                Spacer()
                key("esc", "close")
            }
            .padding(.horizontal, 14).frame(height: 32)
            .background(Theme.sidebar)
            .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
        }
        .background(.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border))
        .shadow(color: .black.opacity(0.13), radius: 9, y: 3)
        .padding(10)
    }

    private func row(_ index: Int) -> some View {
        let candidate = model.candidates[index]
        let directory = candidate.hasSuffix("/")
        let path = directory ? String(candidate.dropLast()) : candidate
        let name = (path as NSString).lastPathComponent.replacingOccurrences(of: "\\ ", with: " ")
        let ext = (name as NSString).pathExtension
        let selected = index == model.selected
        let tint = directory ? accent : (ext == "swift" ? Color(hex: 0xEA580C) : Theme.info)
        return Button {
            model.choose?(index)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: directory ? "folder.fill" : "doc.text")
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(tint)
                    .frame(width: 18)
                Text(name).font(.system(size: 13, weight: selected ? .medium : .regular))
                    .foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.middle)
                if directory { Text("/").foregroundStyle(Theme.faintForeground) }
                Spacer(minLength: 4)
            }
            .padding(.horizontal, 10).frame(height: 34)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 9)
                        .fill(LinearGradient(colors: [Color(hex: 0xEEF2FF), Color(hex: 0xF5F7FF)], startPoint: .leading, endPoint: .trailing))
                        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(accent.opacity(0.13)))
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .frame(height: PathPickerMetrics.rowHeight)
        .onHover { if $0 { model.selected = index } }
        .help(candidate)
        .accessibilityLabel("\(name), \(directory ? "folder" : "file")")
        .accessibilityHint("Insert this path")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func key(_ symbol: String, _ label: String) -> some View {
        HStack(spacing: 4) {
            Text(symbol).font(.system(size: 10, weight: .medium, design: .monospaced))
                .padding(.horizontal, 4).padding(.vertical, 2)
                .background(.white, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.border))
            Text(label).font(.system(size: 10))
        }
        .foregroundStyle(Theme.mutedForeground)
    }
}
