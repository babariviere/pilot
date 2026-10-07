import AppKit
import PilotCore
import SwiftUI

@MainActor
final class ComposerState: ObservableObject {
    @Published var draft = ""
    @Published var error: String?
    @Published var editorHeight: CGFloat = 18
    @Published var queueEditing = QueuedMessageEditing()
    @Published var savingQueueEdit = false
    @Published var queueEditError: String?
    @Published var queueEditorHeight: CGFloat = 18
    @Published var queueFocus = UUID()
    @Published var composerFocus = UUID()

    var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    func selectQueuedMessage(_ message: QueuedMessage) {
        guard !savingQueueEdit else { return }
        queueEditing.select(message)
        queueEditError = nil
        queueFocus = UUID()
    }

    func navigateQueue(_ direction: QueueNavigationDirection, messages: [QueuedMessage]) -> Bool {
        guard !savingQueueEdit else { return true }
        let previous = queueEditing.selected?.id
        let handled = queueEditing.navigate(direction, messages: messages)
        if handled {
            if previous != queueEditing.selected?.id { queueEditError = nil }
            queueFocus = UUID()
        }
        return handled
    }

    func cancelQueueEdit() {
        guard !savingQueueEdit else { return }
        queueEditing.finish()
        queueEditError = nil
        composerFocus = UUID()
    }
}

/// Floating message box at the bottom of a chat.
/// Return steers the current run (or starts one), Option-Return queues a follow-up,
/// Shift-Return adds a line.
struct Composer: View {
    @ObservedObject var state: ComposerState
    let working: Bool
    let queuedMessages: [QueuedMessage]
    let onSend: (String, DeliveryMode) -> Void
    let onStop: () -> Void
    let onEditQueuedMessage: (Int, String) async throws -> Void
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        VStack(spacing: 8) {
            if !queuedMessages.isEmpty || state.queueEditing.selected != nil {
                QueuedMessagesView(state: state, messages: queuedMessages, onSave: saveQueueEdit)
            }
            editor
        }
        .frame(maxWidth: Theme.column)
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .padding(.top, 6)
        .frame(maxWidth: .infinity)
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                if state.draft.isEmpty {
                    Text(working ? "Steer the agent…" : "Reply to Pilot…")
                        .font(fonts.body)
                        .foregroundStyle(Theme.faintForeground)
                        .allowsHitTesting(false)
                }
                ChatTextEditor(
                    text: $state.draft, height: $state.editorHeight, font: fonts.nsBody,
                    focusToken: state.composerFocus,
                    onNavigateQueue: { state.navigateQueue($0, messages: queuedMessages) },
                    onCancel: cancelQueueEditAction
                ) { flags in
                    send(flags.contains(.option) ? .followUp : .steer)
                }
                .frame(height: state.editorHeight)
            }
            HStack(spacing: 10) {
                KeyHints(working: working)
                if let error = state.error {
                    Text(error).font(.caption).foregroundStyle(Theme.destructive).lineLimit(1)
                }
                Spacer()
                if working {
                    Button(action: onStop) { Image(systemName: "stop.fill") }
                        .buttonStyle(CircleIconButtonStyle(tint: Theme.destructive))
                        .help("Stop the current run")
                }
                Button { send(.steer) } label: { Image(systemName: "arrow.up") }
                    .buttonStyle(CircleIconButtonStyle())
                    .disabled(state.trimmed.isEmpty)
                    .help(working ? "Steer (↩)" : "Send (↩)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .card(radius: 14, shadow: true)
    }

    private func send(_ mode: DeliveryMode) {
        let message = state.trimmed
        guard !message.isEmpty else { return }
        onSend(message, mode)
    }

    private var cancelQueueEditAction: (() -> Void)? {
        guard state.queueEditing.selected != nil else { return nil }
        return { state.cancelQueueEdit() }
    }

    private func saveQueueEdit() {
        guard let selected = state.queueEditing.selected, !state.savingQueueEdit else { return }
        let text = state.queueEditing.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard queuedMessages.contains(where: { $0.id == selected.id }) else {
            state.queueEditError = "Message is no longer queued. Your edit has not been sent."
            return
        }
        state.savingQueueEdit = true
        state.queueEditError = nil
        Task {
            do {
                try await onEditQueuedMessage(selected.id, text)
                state.queueEditing.finish()
                state.composerFocus = UUID()
            } catch {
                state.queueEditError = error.localizedDescription
            }
            state.savingQueueEdit = false
        }
    }
}

private struct QueuedMessagesView: View {
    @Environment(\.pilotFonts) private var fonts
    @ObservedObject var state: ComposerState
    let messages: [QueuedMessage]
    let onSave: () -> Void

    private var displayedMessages: [QueuedMessage] {
        if let selected = state.queueEditing.selected, !messages.contains(where: { $0.id == selected.id }) {
            return messages + [selected]
        }
        return messages
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("\(messages.count) queued", systemImage: "tray.full")
                Spacer()
                Text("⌥↑ / ⌥↓ to edit")
            }
            .font(.caption)
            .foregroundStyle(Theme.mutedForeground)
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
                    ViewThatFits(in: .vertical) {
                        rows
                        ScrollView { rows }.frame(height: 180)
                    }
                    .frame(maxHeight: 180)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: 12)
    }

    private var editingHeight: CGFloat {
        let unavailable = !messages.contains { $0.id == state.queueEditing.selected?.id }
        let errorHeight: CGFloat = state.queueEditError != nil || unavailable ? 32 : 0
        return min(state.queueEditorHeight + 72 + CGFloat(displayedMessages.count - 1) * 48 + errorHeight, 260)
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(displayedMessages) { message in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(message.mode == .followUp ? "Follow-up" : "Steering")
                            .font(.caption)
                            .foregroundStyle(Theme.mutedForeground)
                        Spacer()
                        if state.queueEditing.selected?.id == message.id {
                            Text("Editing").font(.caption).foregroundStyle(Theme.mutedForeground)
                        } else {
                            if state.queueEditing.hasUnsavedEdit(message) {
                                Text("Unsaved edit").font(.caption).foregroundStyle(Theme.mutedForeground)
                            }
                            Button { state.selectQueuedMessage(message) } label: {
                                Label("Edit", systemImage: "pencil").font(.caption)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.mutedForeground)
                            .disabled(state.savingQueueEdit)
                            .help("Edit this queued message")
                        }
                    }
                    if state.queueEditing.selected?.id == message.id {
                        QueuedMessageEditor(
                            state: state,
                            available: messages.contains(where: { $0.id == message.id }),
                            onSave: onSave,
                            onNavigate: { state.navigateQueue($0, messages: messages) }
                        )
                    } else {
                        Text(message.text)
                            .font(fonts.body)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .id(message.id)
            }
        }
    }
}

private struct KeyHints: View {
    let working: Bool

    var body: some View {
        HStack(spacing: 10) {
            hint("↩", working ? "steer" : "send")
            if working { hint("⌥↩", "follow up") }
            hint("⇧↩", "new line")
        }
        .font(.system(size: 11))
        .foregroundStyle(Theme.faintForeground)
    }

    private func hint(_ key: String, _ label: String) -> some View {
        HStack(spacing: 4) {
            Text(key)
                .font(.system(size: 10, weight: .medium))
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 4).fill(Theme.muted))
            Text(label)
        }
    }
}
