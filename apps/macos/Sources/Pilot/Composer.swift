import AppKit
import PilotCore
import SwiftUI

@MainActor
final class ComposerState: ObservableObject {
    @Published var draft = ""
    @Published var attachments = ImageAttachments()
    @Published var error: String?
    @Published var editorHeight: CGFloat = 18
    @Published var queueEditing = QueuedMessageEditing()
    @Published var savingQueueEdit = false
    @Published var removingQueuedMessage: Int?
    @Published private(set) var removedQueuedMessages: Set<Int> = []
    @Published var queueRemovalError: String?
    @Published var queueEditError: String?
    @Published var queueEditorHeight: CGFloat = 18
    @Published var queueFocus = UUID()
    @Published var composerFocus = UUID()

    var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    var mutatingQueue: Bool { savingQueueEdit || removingQueuedMessage != nil }

    /// HTTP can acknowledge removal before the queue stream catches up (or while it reconnects).
    /// Submission IDs are never reused within a session.
    func remainingQueuedMessages(_ messages: [QueuedMessage]) -> [QueuedMessage] {
        messages.filter { !removedQueuedMessages.contains($0.id) }
    }

    func canSend(changingModel: Bool) -> Bool { !changingModel && (!trimmed.isEmpty || !attachments.items.isEmpty) }

    func selectQueuedMessage(_ message: QueuedMessage) {
        guard !mutatingQueue, !removedQueuedMessages.contains(message.id) else { return }
        queueEditing.select(message)
        queueEditError = nil
        queueFocus = UUID()
    }

    func navigateQueue(_ direction: QueueNavigationDirection, messages: [QueuedMessage]) -> Bool {
        guard !mutatingQueue else { return true }
        let previous = queueEditing.selected?.id
        let handled = queueEditing.navigate(direction, messages: remainingQueuedMessages(messages))
        if handled {
            if previous != queueEditing.selected?.id { queueEditError = nil }
            queueFocus = UUID()
        }
        return handled
    }

    func cancelQueueEdit() {
        guard !mutatingQueue else { return }
        queueEditing.finish()
        queueEditError = nil
        composerFocus = UUID()
    }

    func removeQueuedMessage(_ id: Int, perform: (Int) async throws -> Void) async {
        guard !mutatingQueue else { return }
        removingQueuedMessage = id
        queueRemovalError = nil
        defer { removingQueuedMessage = nil }
        do {
            try await perform(id)
            removedQueuedMessages.insert(id)
            let wasSelected = queueEditing.selected?.id == id
            queueEditing.remove(id)
            if wasSelected {
                queueEditError = nil
                composerFocus = UUID()
            }
        } catch {
            queueRemovalError = error.localizedDescription
        }
    }
}

/// Floating message box at the bottom of a chat.
/// Return steers the current run (or starts one), Option-Return queues a follow-up,
/// Shift-Return adds a line.
struct Composer: View {
    @ObservedObject var state: ComposerState
    let working: Bool
    let queuedMessages: [QueuedMessage]
    let completionDirectory: String
    let onSend: (String, DeliveryMode) -> Void
    let onStop: () -> Void
    let onEditQueuedMessage: (Int, String) async throws -> Void
    let onRemoveQueuedMessage: (Int) async throws -> Void
    var session: SessionSummary? = nil
    @StateObject private var modelPicker = ChatModelPickerState()
    @Environment(\.pilotFonts) private var fonts

    private var remainingQueuedMessages: [QueuedMessage] { state.remainingQueuedMessages(queuedMessages) }

    var body: some View {
        VStack(spacing: 8) {
            if !remainingQueuedMessages.isEmpty || state.queueEditing.selected != nil || state.queueRemovalError != nil {
                QueuedMessagesView(state: state, messages: remainingQueuedMessages, completionDirectory: completionDirectory,
                                   onSave: saveQueueEdit, onRemove: { id in
                                       Task { await state.removeQueuedMessage(id, perform: onRemoveQueuedMessage) }
                                   })
            }
            editor
            controls
            if let error = state.error {
                Text(error).font(.caption).foregroundStyle(Theme.destructive)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: Theme.column)
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .padding(.top, 6)
        .frame(maxWidth: .infinity)
        .task(id: session?.cwd) {
            if let session { await modelPicker.loadModels(cwd: session.cwd) }
        }
        .alert("Model and thinking", isPresented: Binding(
            get: { modelPicker.error != nil }, set: { if !$0 { modelPicker.error = nil } }
        )) {
            Button("OK") { modelPicker.error = nil }
        } message: {
            Text(modelPicker.error ?? "")
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            ImageAttachmentPreviews(attachments: $state.attachments)
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
                    onNavigateQueue: { state.navigateQueue($0, messages: remainingQueuedMessages) },
                    onCancel: cancelQueueEditAction,
                    onPasteImages: { state.attachments.paste(from: $0) },
                    completionDirectory: completionDirectory
                ) { flags in
                    send(flags.contains(.option) ? .followUp : .steer)
                }
                .frame(height: state.editorHeight)
            }
            HStack(spacing: 10) {
                KeyHints(working: working)
                Spacer()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .card(radius: 14, shadow: true)
    }

    private var controls: some View {
        HStack(alignment: .top, spacing: 10) {
            if let session {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) {
                        modelControls(session)
                        UsageFooter(usage: session.usage ?? SessionUsage(), model: session.model)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        modelControls(session)
                        UsageFooter(usage: session.usage ?? SessionUsage(), model: session.model)
                    }
                }
                .padding(.top, 5)
            }
            Spacer(minLength: 8)
            HStack(spacing: 8) {
                if working {
                    Button(action: onStop) { Image(systemName: "stop.fill") }
                        .buttonStyle(CircleIconButtonStyle(tint: Theme.destructive))
                        .help("Stop the current run")
                }
                Button { send(.steer) } label: { Image(systemName: "arrow.up") }
                    .buttonStyle(CircleIconButtonStyle())
                    .disabled(!state.canSend(changingModel: modelPicker.changing))
                    .help(working ? "Steer (↩)" : "Send (↩)")
            }
        }
        .padding(.horizontal, 10)
    }

    private func send(_ mode: DeliveryMode) {
        let message = state.attachments.message(text: state.trimmed)
        guard state.canSend(changingModel: modelPicker.changing) else { return }
        onSend(message, mode)
    }

    private func modelControls(_ session: SessionSummary) -> some View {
        ChatModelControls(session: session, working: working || !queuedMessages.isEmpty, state: modelPicker)
    }

    private var cancelQueueEditAction: (() -> Void)? {
        guard state.queueEditing.selected != nil else { return nil }
        return { state.cancelQueueEdit() }
    }

    private func saveQueueEdit() {
        guard let selected = state.queueEditing.selected, !state.mutatingQueue else { return }
        let text = state.queueEditing.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard remainingQueuedMessages.contains(where: { $0.id == selected.id }) else {
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
    let completionDirectory: String
    let onSave: () -> Void
    let onRemove: (Int) -> Void

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
            if let error = state.queueRemovalError {
                HStack {
                    Text(error).font(.caption).foregroundStyle(Theme.destructive).textSelection(.enabled)
                    Spacer()
                    Button { state.queueRemovalError = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain)
                        .help("Dismiss removal error")
                        .accessibilityLabel("Dismiss removal error")
                }
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
                            .disabled(state.mutatingQueue)
                            .help("Edit this queued message")
                        }
                        if state.removingQueuedMessage == message.id {
                            ProgressView().controlSize(.small)
                        }
                        Button { onRemove(message.id) } label: {
                            Label("Remove", systemImage: "trash").font(.caption)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.destructive)
                        .disabled(state.mutatingQueue || !messages.contains(where: { $0.id == message.id }))
                        .help("Remove this queued message")
                    }
                    if state.queueEditing.selected?.id == message.id {
                        QueuedMessageEditor(
                            state: state,
                            available: messages.contains(where: { $0.id == message.id }),
                            completionDirectory: completionDirectory,
                            onSave: onSave,
                            onRemove: { onRemove(message.id) },
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
