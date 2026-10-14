import AppKit
import PilotCore
import SwiftUI

@MainActor
final class ComposerDraftState: ObservableObject {
    var onDraftChanged: (() -> Void)?
    @Published var draft = "" {
        didSet {
            trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            onDraftChanged?()
        }
    }
    @Published var height: CGFloat = 18
    private(set) var trimmed = ""
}

@MainActor
final class ComposerState: ObservableObject {
    var onDraftChanged: (() -> Void)? {
        didSet { draftState.onDraftChanged = onDraftChanged }
    }
    // Draft edits and measured height changes must not invalidate the static controls.
    // Keep the existing imperative API for send/restore callers.
    let draftState = ComposerDraftState()
    var draft: String {
        get { draftState.draft }
        set { draftState.draft = newValue }
    }
    @Published var attachments = ImageAttachments() { didSet { onDraftChanged?() } }
    @Published var error: String?
    var editorHeight: CGFloat {
        get { draftState.height }
        set { draftState.height = newValue }
    }
    @Published var queueEditing = QueuedMessageEditing() { didSet { onDraftChanged?() } }
    @Published var mutatingHeldMessages = false
    @Published var savingQueueEdit = false
    @Published var removingQueuedMessage: Int?
    @Published private(set) var removedQueuedMessages: Set<Int> = []
    @Published var queueRemovalError: String?
    @Published var queueEditError: String?
    @Published var queueEditorHeight: CGFloat = 18
    @Published var queueFocus = UUID()
    @Published var composerFocus = UUID()

    var trimmed: String { draftState.trimmed }
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

    func dismissQueueRemovalError() {
        queueRemovalError = nil
    }

    /// The view owns the delay task, cancelling it on replacement or disappearance.
    /// Never let an obsolete task dismiss a newer failure or change an unsent draft.
    func dismissQueueRemovalError(after delay: Duration) async {
        guard let error = queueRemovalError else { return }
        do { try await Task.sleep(for: delay) }
        catch { return }
        guard !Task.isCancelled, queueRemovalError == error else { return }
        dismissQueueRemovalError()
    }

    /// Held actions never touch the user's drafts or editable queue.
    func performHeldAction(_ perform: () async throws -> Void) async {
        guard !mutatingHeldMessages else { return }
        mutatingHeldMessages = true
        error = nil
        defer { mutatingHeldMessages = false }
        do { try await perform() }
        catch { error = error.localizedDescription }
    }

    func discardHeldMessages(_ id: Int?, perform: (Int?) async throws -> Void) async {
        await performHeldAction { try await perform(id) }
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
/// Shift-Return adds a line. Queued messages sit at the top of the same tray; editing one uses the
/// same keys, so Return saves it as steering and Option-Return as a follow-up. Submitting an
/// empty queue edit removes the message instead. Waiting system messages sit above the queue as one
/// read-only line (`SystemMessagesStrip`).
struct Composer: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var state: ComposerState
    let working: Bool
    let queuedMessages: [QueuedMessage]
    /// Automatic input waiting in the inbox, in submission order.
    let automaticInputs: [PendingAutomaticInput]
    let completionDirectory: String?
    let onSend: (String, DeliveryMode) -> Void
    let onStop: () -> Void
    let onEditQueuedMessage: (Int, String, DeliveryMode) async throws -> Void
    let onRemoveQueuedMessage: (Int) async throws -> Void
    let onSendHeld: (() async throws -> Void)?
    let onDiscardHeld: ((Int?) async throws -> Void)?
    var session: SessionSummary? = nil
    /// Slash command menu entries; nil disables the menu.
    var slashCommands: [SlashCommand]? = nil
    var onSlashCommandsNeeded: (() -> Void)? = nil
    /// Send later: the message and when it starts. Nil hides the control.
    var onSchedule: ((String, ScheduleWhen) -> Void)? = nil
    @StateObject private var modelPicker: ChatModelPickerState

    init(
        state: ComposerState,
        working: Bool,
        queuedMessages: [QueuedMessage],
        automaticInputs: [PendingAutomaticInput] = [],
        completionDirectory: String?,
        onSend: @escaping (String, DeliveryMode) -> Void,
        onStop: @escaping () -> Void,
        onEditQueuedMessage: @escaping (Int, String, DeliveryMode) async throws -> Void,
        onRemoveQueuedMessage: @escaping (Int) async throws -> Void,
        onSendHeld: (() async throws -> Void)? = nil,
        onDiscardHeld: ((Int?) async throws -> Void)? = nil,
        session: SessionSummary? = nil,
        slashCommands: [SlashCommand]? = nil,
        onSlashCommandsNeeded: (() -> Void)? = nil,
        onSchedule: ((String, ScheduleWhen) -> Void)? = nil
    ) {
        self.state = state
        self.working = working
        self.queuedMessages = queuedMessages
        self.automaticInputs = automaticInputs
        self.completionDirectory = completionDirectory
        self.onSend = onSend
        self.onStop = onStop
        self.onEditQueuedMessage = onEditQueuedMessage
        self.onRemoveQueuedMessage = onRemoveQueuedMessage
        self.onSendHeld = onSendHeld
        self.onDiscardHeld = onDiscardHeld
        self.session = session
        self.slashCommands = slashCommands
        self.onSlashCommandsNeeded = onSlashCommandsNeeded
        self.onSchedule = onSchedule
        _modelPicker = StateObject(wrappedValue: ChatModelPickerState(cwd: session?.cwd))
    }

    private var remainingQueuedMessages: [QueuedMessage] { state.remainingQueuedMessages(queuedMessages) }

    private var showsQueue: Bool {
        !remainingQueuedMessages.isEmpty || state.queueEditing.selected != nil || state.queueRemovalError != nil
    }

    private var systemMessages: [PendingAutomaticInput] {
        SystemMessagesStrip.visible(automaticInputs, working: working)
    }

    var body: some View {
        let systemMessages = systemMessages
        VStack(spacing: 8) {
            // Opaque tray, like the new-chat composer, so transcript text never shows behind the controls.
            VStack(spacing: 0) {
                if let session, onSchedule != nil {
                    ScheduledFollowUpsStrip(sessionId: session.id)
                }
                if !systemMessages.isEmpty {
                    VStack(spacing: 2) {
                        SystemMessagesStrip(inputs: systemMessages,
                                            onSendHeld: onSendHeld.map { send -> () -> Void in
                                                { Task { await state.performHeldAction(send) } }
                                            },
                                            onDiscardHeld: onDiscardHeld.map { discard -> () -> Void in
                                                { Task { await state.discardHeldMessages(nil, perform: discard) } }
                                            },
                                            onDiscardRow: onDiscardHeld.map { discard -> (Int) -> Void in
                                                { id in Task { await state.discardHeldMessages(id, perform: discard) } }
                                            })
                            .disabled(state.mutatingHeldMessages)
                        if showsQueue {
                            Rectangle().fill(Theme.border).frame(height: 1).padding(.horizontal, 8)
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                    .transition(.opacity)
                }
                if showsQueue {
                    QueuedMessagesStrip(state: state, messages: remainingQueuedMessages, completionDirectory: completionDirectory,
                                        onSave: saveQueueEdit, onRemove: { id in
                                            Task { await state.removeQueuedMessage(id, perform: onRemoveQueuedMessage) }
                                        })
                        .transition(.opacity)
                }
                editor
                controls
            }
            .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: showsQueue)
            .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: systemMessages.isEmpty)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(Theme.tray)
                    .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
            )
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border))
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
        .task(id: state.queueRemovalError) {
            await state.dismissQueueRemovalError(after: .seconds(5))
        }
        .onDisappear { state.dismissQueueRemovalError() }
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
            ComposerDraftEditor(
                state: state.draftState, working: working, focusToken: state.composerFocus,
                onNavigateQueue: { state.navigateQueue($0, messages: remainingQueuedMessages) },
                onCancel: cancelQueueEditAction,
                onPasteImages: { state.attachments.paste(from: $0) },
                completionDirectory: completionDirectory,
                slashCommands: slashCommands,
                onSlashCommandsNeeded: onSlashCommandsNeeded
            ) { flags in
                send(flags.contains(.option) ? .followUp : .steer)
            }
            HStack(spacing: 10) {
                KeyHints(working: working, queued: !remainingQueuedMessages.isEmpty)
                Spacer()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .card(radius: 10)
        .padding([.horizontal, .top], 4)
    }

    private var controls: some View {
        HStack(alignment: .controlsFirstRow, spacing: 10) {
            if let session {
                ResponsiveControlsLayout(horizontalSpacing: 16, verticalSpacing: 8) {
                    modelControls(session)
                    UsageFooter(usage: session.usage ?? SessionUsage(), model: session.model)
                }
            }
            Spacer(minLength: 8)
            if let onSchedule {
                ComposerSendLater(state: state, draft: state.draftState, modelPicker: modelPicker,
                                  sendNow: { send(.steer) }) { when in
                    guard state.canSend(changingModel: modelPicker.changing) else { return }
                    onSchedule(state.attachments.message(text: state.trimmed), when)
                }
            }
            ComposerSendButtons(state: state, draft: state.draftState, modelPicker: modelPicker,
                                working: working, onStop: onStop, onSend: { send(.steer) })
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
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

    private func saveQueueEdit(_ mode: DeliveryMode) {
        guard let selected = state.queueEditing.selected, !state.mutatingQueue else { return }
        let text = state.queueEditing.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard remainingQueuedMessages.contains(where: { $0.id == selected.id }) else {
            state.queueEditError = "Message is no longer queued. Your edit has not been sent."
            return
        }
        if text.isEmpty {
            state.queueEditError = nil
            Task { await state.removeQueuedMessage(selected.id, perform: onRemoveQueuedMessage) }
            return
        }
        state.savingQueueEdit = true
        state.queueEditError = nil
        Task {
            do {
                try await onEditQueuedMessage(selected.id, text, mode)
                state.queueEditing.finish()
                state.composerFocus = UUID()
            } catch {
                state.queueEditError = error.localizedDescription
            }
            state.savingQueueEdit = false
        }
    }
}

private struct ComposerDraftEditor: View {
    @ObservedObject var state: ComposerDraftState
    let working: Bool
    let focusToken: UUID
    let onNavigateQueue: (QueueNavigationDirection) -> Bool
    let onCancel: (() -> Void)?
    let onPasteImages: (NSPasteboard) -> Bool
    let completionDirectory: String?
    let slashCommands: [SlashCommand]?
    let onSlashCommandsNeeded: (() -> Void)?
    let onSubmit: (NSEvent.ModifierFlags) -> Void
    @Environment(\.pilotFonts) private var fonts

    var body: some View {
        ZStack(alignment: .topLeading) {
            if state.draft.isEmpty {
                Text(working ? "Steer the agent…" : "Reply to Pilot…")
                    .font(fonts.body)
                    .foregroundStyle(Theme.faintForeground)
                    .allowsHitTesting(false)
            }
            ChatTextEditor(text: $state.draft, height: $state.height, font: fonts.nsBody,
                           focusToken: focusToken, onNavigateQueue: onNavigateQueue, onCancel: onCancel,
                           onPasteImages: onPasteImages, completionDirectory: completionDirectory,
                           slashCommands: slashCommands, onSlashCommandsNeeded: onSlashCommandsNeeded,
                           onSubmit: onSubmit)
                .frame(height: state.height)
        }
    }
}

private struct ComposerSendButtons: View {
    @ObservedObject var state: ComposerState
    @ObservedObject var draft: ComposerDraftState
    @ObservedObject var modelPicker: ChatModelPickerState
    let working: Bool
    let onStop: () -> Void
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if working {
                Button(action: onStop) { Image(systemName: "stop.fill") }
                    .buttonStyle(CircleIconButtonStyle(tint: Theme.destructive))
                    .help("Stop the current run")
            }
            Button(action: onSend) { Image(systemName: "arrow.up") }
                .buttonStyle(CircleIconButtonStyle())
                .disabled(!state.canSend(changingModel: modelPicker.changing))
                .help(working ? "Steer (↩)" : "Send (↩)")
        }
    }
}

/// Observes the draft on its own, like the send buttons, so typing never re-renders the composer.
private struct ComposerSendLater: View {
    @ObservedObject var state: ComposerState
    @ObservedObject var draft: ComposerDraftState
    @ObservedObject var modelPicker: ChatModelPickerState
    /// The Send button's action, offered by the Wi-Fi triggers when their condition already holds.
    let sendNow: () -> Void
    let schedule: (ScheduleWhen) -> Void

    var body: some View {
        SendLaterMenu(disabled: !state.canSend(changingModel: modelPicker.changing), sendNow: sendNow, schedule: schedule)
    }
}

private struct KeyHints: View {
    let working: Bool
    var queued = false

    var body: some View {
        HStack(spacing: 10) {
            KeyHint(key: "↩", label: working ? "steer" : "send")
            if working { KeyHint(key: "⌥↩", label: "follow up") }
            KeyHint(key: "⇧↩", label: "new line")
            if queued { KeyHint(key: "⌥↑↓", label: "edit queue") }
        }
    }
}
