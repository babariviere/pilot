import PilotCore
import SwiftUI

/// Queued messages as one-line rows at the top of the composer tray, in delivery order.
/// Details stay out of the way: actions appear on hover, and the selected row opens into an editor.
struct QueuedMessagesStrip: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var state: ComposerState
    let messages: [QueuedMessage]
    let completionDirectory: String?
    let onSave: (DeliveryMode) -> Void
    let onRemove: (Int) -> Void

    static let rowHeight: CGFloat = 26
    private static let visibleRows: CGFloat = 5

    private var displayedMessages: [QueuedMessage] {
        if let selected = state.queueEditing.selected, !messages.contains(where: { $0.id == selected.id }) {
            return messages + [selected]
        }
        return messages
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let error = state.queueRemovalError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.pilot(.caption))
                    Text(error).font(.pilot(.caption)).textSelection(.enabled).lineLimit(2)
                    Spacer(minLength: 4)
                    Button { state.queueRemovalError = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(QuietIconButtonStyle())
                        .help("Dismiss removal error")
                        .accessibilityLabel("Dismiss removal error")
                }
                .foregroundStyle(Theme.destructive)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .transition(.opacity)
            }
            ScrollViewReader { proxy in
                if state.queueEditing.selected != nil {
                    // One editor subtree: ViewThatFits must not create two competing NSTextViews.
                    ScrollView { rows }
                        .frame(height: editingHeight)
                        .onAppear {
                            if let id = state.queueEditing.selected?.id { proxy.scrollTo(id, anchor: .center) }
                        }
                        .onChange(of: state.queueEditing.selected?.id) { _, id in
                            if let id { proxy.scrollTo(id, anchor: .center) }
                        }
                        .onChange(of: state.queueEditorHeight) { _, _ in
                            if let id = state.queueEditing.selected?.id { proxy.scrollTo(id, anchor: .center) }
                        }
                } else {
                    let maxHeight = (Self.rowHeight + 2) * Self.visibleRows
                    ViewThatFits(in: .vertical) {
                        rows
                        ScrollView { rows }.frame(height: maxHeight)
                    }
                    .frame(maxHeight: maxHeight)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
        .clipped()
        // Rows animate in and out, but opening or closing the inline editor does not: an animated
        // removal keeps the old NSTextView alive briefly, and it could hold focus while the next opens.
        .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: displayedMessages.map(\.id))
        .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: state.queueRemovalError)
    }

    private var editingHeight: CGFloat {
        let unavailable = !messages.contains { $0.id == state.queueEditing.selected?.id }
        let errorHeight: CGFloat = state.queueEditError != nil || unavailable ? 20 : 0
        let others = CGFloat(displayedMessages.count - 1) * (Self.rowHeight + 2)
        // Editor chrome: field padding, the hint and button row, and row padding.
        return min(state.queueEditorHeight + 48 + others + errorHeight, 260)
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(displayedMessages) { message in
                QueuedMessageRow(
                    state: state,
                    message: message,
                    available: messages.contains(where: { $0.id == message.id }),
                    completionDirectory: completionDirectory,
                    onSave: onSave,
                    onRemove: { onRemove(message.id) },
                    onNavigate: { state.navigateQueue($0, messages: messages) }
                )
                .id(message.id)
                .transition(Theme.Motion.insertion(reduceMotion: reduceMotion))
            }
        }
    }
}

/// One queued message: its delivery mode symbol and first line, or its inline editor when selected.
private struct QueuedMessageRow: View {
    @Environment(\.pilotFonts) private var fonts
    @ObservedObject var state: ComposerState
    let message: QueuedMessage
    let available: Bool
    let completionDirectory: String?
    let onSave: (DeliveryMode) -> Void
    let onRemove: () -> Void
    let onNavigate: (QueueNavigationDirection) -> Bool
    @StateObject private var hover = HoverState()

    private var editing: Bool { state.queueEditing.selected?.id == message.id }
    private var removing: Bool { state.removingQueuedMessage == message.id }

    var body: some View {
        if editing {
            HStack(alignment: .top, spacing: 8) {
                QueueModeSymbol(mode: message.mode).padding(.top, 9)
                QueuedMessageEditor(
                    state: state,
                    available: available,
                    completionDirectory: completionDirectory,
                    onSave: onSave,
                    onRemove: onRemove,
                    onNavigate: onNavigate
                )
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
        } else {
            summary
        }
    }

    private var summary: some View {
        HStack(spacing: 8) {
            QueueModeSymbol(mode: message.mode)
            Text(message.text.replacingOccurrences(of: "\n", with: " "))
                .font(fonts.body)
                .foregroundStyle(hover.isHovered ? Theme.foreground : Theme.mutedForeground)
                .lineLimit(1)
                .truncationMode(.tail)
            if state.queueEditing.hasUnsavedEdit(message) {
                Circle().fill(Theme.warning).frame(width: 6, height: 6)
                    .help("Unsaved edit. Press ⌥↑ or ⌥↓ to return to it.")
                    .accessibilityLabel("Unsaved edit")
            }
            Spacer(minLength: 4)
            if removing {
                ProgressView().controlSize(.mini)
            } else if hover.isHovered {
                HStack(spacing: 0) {
                    Button { state.selectQueuedMessage(message) } label: { Image(systemName: "pencil") }
                        .buttonStyle(QuietIconButtonStyle())
                        .disabled(state.mutatingQueue)
                        .help("Edit this queued message")
                        .accessibilityLabel("Edit queued message")
                    Button(action: onRemove) { Image(systemName: "xmark") }
                        .buttonStyle(QuietIconButtonStyle(hoverTint: Theme.destructive))
                        .disabled(state.mutatingQueue || !available)
                        .help("Remove this queued message")
                        .accessibilityLabel("Remove queued message")
                }
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(hover.isHovered ? Theme.selected : .clear))
        .contentShape(RoundedRectangle(cornerRadius: 6))
        .opacity(removing ? 0.5 : 1)
        .onTapGesture { state.selectQueuedMessage(message) }
        .onHover { hover.isHovered = $0 }
        .animation(Theme.Motion.quick, value: hover.isHovered)
        // Hover-only buttons stay reachable for VoiceOver through named actions.
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.mode == .steer ? "Steering" : "Follow-up"): \(message.text)")
        .accessibilityAction(named: "Edit") { state.selectQueuedMessage(message) }
        .accessibilityAction(named: "Remove") { if available, !state.mutatingQueue { onRemove() } }
    }
}

/// Delivery mode as a small symbol: steering lands during the current run, follow-ups wait for it.
struct QueueModeSymbol: View {
    let mode: DeliveryMode

    var body: some View {
        Image(systemName: mode == .steer ? "arrow.turn.down.right" : "clock.arrow.circlepath")
            .font(.pilot(.caption, weight: .semibold))
            .foregroundStyle(mode == .steer ? Theme.info : Theme.faintForeground)
            .frame(width: 14)
            .help(mode == .steer ? "Steering: delivered during the current run" : "Follow-up: sent after the current run")
            .accessibilityLabel(mode == .steer ? "Steering" : "Follow-up")
    }
}
