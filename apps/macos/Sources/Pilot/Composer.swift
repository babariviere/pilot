import AppKit
import PilotCore
import SwiftUI

@MainActor
final class ComposerDraftState: ObservableObject {
    var onDraftChanged: (() -> Void)?
    /// Called when the composer's text view gains or loses keyboard focus. Not published: focus never re-renders it.
    var onEditingChanged: ((Bool) -> Void)?
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
    @Published var delivering = false
    var pendingOperationId: String? { didSet { onDraftChanged?() } }
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
    /// Keyboard requests from ⌘K: fold or unfold the tray's task and subagent lists, or open "At a time…".
    @Published var tasksToggle = 0
    @Published var subagentsToggle = 0
    @Published var scheduleAtTime = 0

    var trimmed: String { draftState.trimmed }
    var mutatingQueue: Bool { savingQueueEdit || removingQueuedMessage != nil }

    /// HTTP can acknowledge removal before the queue stream catches up (or while it reconnects).
    /// Submission IDs are never reused within a session.
    func remainingQueuedMessages(_ messages: [QueuedMessage]) -> [QueuedMessage] {
        messages.filter { !removedQueuedMessages.contains($0.id) }
    }

    func canSend(changingModel: Bool) -> Bool { !delivering && !changingModel && (!trimmed.isEmpty || !attachments.items.isEmpty) }

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
        catch { self.error = error.localizedDescription }
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
/// While the chat works, the tray wears the sidebar row's dithered working corner in its bottom-right
/// (`ComposerCorner`): the same ripple, fainter and half as fast while only background jobs run, nothing when idle.
struct Composer: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.hostViewContext) private var hostContext
    @ObservedObject var state: ComposerState
    let working: Bool
    let hostAvailable: Bool
    let rawAttachments: Bool
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
    /// The agent's todo list, summarised as one line at the top of the tray.
    var todos: [SessionTodo] = []
    /// Slash command menu entries; nil disables the menu.
    var slashCommands: [SlashCommand]? = nil
    var onSlashCommandsNeeded: (() -> Void)? = nil
    /// Runs an app command (`/terminal`, `/model`…) picked from the slash menu. Never sends anything.
    var onAppCommand: ((SlashCommand) -> Void)? = nil
    /// Send later: the message and when it starts. Nil hides the control.
    var onSchedule: ((String, ScheduleWhen) -> Void)? = nil
    @StateObject private var modelPicker: ChatModelPickerState

    init(
        state: ComposerState,
        working: Bool,
        hostAvailable: Bool = true,
        rawAttachments: Bool = false,
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
        todos: [SessionTodo] = [],
        slashCommands: [SlashCommand]? = nil,
        onSlashCommandsNeeded: (() -> Void)? = nil,
        onAppCommand: ((SlashCommand) -> Void)? = nil,
        onSchedule: ((String, ScheduleWhen) -> Void)? = nil,
        context: HostViewContext? = nil
    ) {
        self.state = state
        self.working = working
        self.hostAvailable = hostAvailable
        self.rawAttachments = rawAttachments
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
        self.todos = todos
        self.slashCommands = slashCommands
        self.onSlashCommandsNeeded = onSlashCommandsNeeded
        self.onAppCommand = onAppCommand
        self.onSchedule = onSchedule
        if let context {
            _modelPicker = StateObject(wrappedValue: ChatModelPickerState(cwd: session?.cwd,
                changeModel: { id, request in _ = try await context.perform(.session, id) { client, id in try await client.changeModel(id, model: request.model, thinking: request.thinking) } },
                cachedModels: { cwd in context.hosts.presentationClient(context.host).cachedModels(projectId: nil, cwd: cwd) },
                fetchModels: { cwd in try await context.perform(.session, session?.id ?? "") { client, _ in try await client.models(projectId: nil, cwd: cwd) } },
                continueModel: { id, request in try await context.perform(.session, id) { client, id in try await client.continueModel(id, model: request.model, thinking: request.thinking) } },
                showContinuedChat: { next in try? AppModel.shared.selectSession(context.ref(.session, next.id)) }))
        } else { _modelPicker = StateObject(wrappedValue: ChatModelPickerState(cwd: session?.cwd)) }
    }

    private var remainingQueuedMessages: [QueuedMessage] { state.remainingQueuedMessages(queuedMessages) }

    private var corner: ComposerCorner { ComposerCorner(agentWorking: working, session: session) }

    private var showsQueue: Bool {
        !remainingQueuedMessages.isEmpty || state.queueEditing.selected != nil || state.queueRemovalError != nil
    }

    private var systemMessages: [PendingAutomaticInput] {
        SystemMessagesStrip.visible(automaticInputs, working: working)
    }

    private var showsSubagents: Bool {
        guard let session, !session.isAsk else { return false }
        return !(session.subagents ?? []).isEmpty
    }

    /// Tasks and subagents: one summary line each, above the system messages and the queue.
    private var showsStatusLines: Bool { (!todos.isEmpty && session != nil) || showsSubagents }

    private var trayDivider: some View {
        Rectangle().fill(Theme.border).frame(height: 1).padding(.horizontal, 8)
    }

    var body: some View {
        let systemMessages = systemMessages
        VStack(spacing: 8) {
            if let session {
                SubscriptionLimitNotice(session: session, working: working, modelPicker: modelPicker) { state.error = $0 }
            }
            // Opaque tray, like the new-chat composer, so transcript text never shows behind the controls.
            VStack(spacing: 0) {
                if showsStatusLines || !systemMessages.isEmpty {
                    VStack(spacing: 2) {
                        if let session, !todos.isEmpty {
                            TasksStrip(todos: todos, sessionId: session.id, toggleRequest: state.tasksToggle)
                        }
                        if showsSubagents, let session {
                            if !todos.isEmpty { trayDivider }
                            SubagentsStrip(session: session, toggleRequest: state.subagentsToggle)
                        }
                        if !systemMessages.isEmpty {
                            if showsStatusLines { trayDivider }
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
                        }
                        if showsQueue {
                            trayDivider
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
            // Strips inside keep their own hover fills; the corner below is the tray's, not a row's.
            .environment(\.rowHasDitherCorner, false)
            .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: showsQueue)
            .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: systemMessages.isEmpty)
            .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: showsStatusLines)
            // Behind the opaque editor card, so it shows only in the tray's margin and beside the controls, and
            // clipped to the tray's rounded shape.
            .ditherCorner(corner.signal, background: corner.background, outset: EdgeInsets(),
                          cornerRadius: Theme.Radius.tray, extent: ComposerCorner.extent, recedes: false)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.tray)
                    .fill(Theme.tray)
                    .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
            )
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.tray).strokeBorder(Theme.border))
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
        .keyboardRegion(.composer) {
            state.composerFocus = UUID()
            return true
        }
        .composerCommands(revision: commandsRevision) { composerCommandList() }
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
        .sheet(item: $modelPicker.continuation) { _ in
            if let session { ModelContinuationSheet(session: session, state: modelPicker) }
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            ImageAttachmentPreviews(attachments: $state.attachments)
            ComposerDraftEditor(
                state: state.draftState, working: working, focusToken: state.composerFocus,
                onNavigateQueue: { state.navigateQueue($0, messages: remainingQueuedMessages) },
                onCancel: cancelQueueEditAction ?? { KeyboardFocus.leaveComposer() },
                onPasteImages: { state.attachments.paste(from: $0) },
                completionDirectory: completionDirectory,
                slashCommands: slashCommands,
                onSlashCommandsNeeded: onSlashCommandsNeeded,
                onAppCommand: onAppCommand
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
        .card()
        .padding([.horizontal, .top], 4)
    }

    private var controls: some View {
        HStack(alignment: .controlsFirstRow, spacing: 10) {
            if let session {
                modelControls(session)
            }
            Spacer(minLength: 8)
            if let session { ContextUsageIndicator(usage: session.usage ?? SessionUsage()) }
            if let onSchedule {
                ComposerSendLater(state: state, draft: state.draftState, modelPicker: modelPicker) { when in
                    guard hostAvailable, state.canSend(changingModel: modelPicker.changing) else { return }
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
        let message = rawAttachments ? state.trimmed : state.attachments.message(text: state.trimmed)
        guard hostAvailable, state.canSend(changingModel: modelPicker.changing) else { return }
        onSend(message, mode)
    }

    private func modelControls(_ session: SessionSummary) -> some View {
        ChatModelControls(session: session, working: working || !queuedMessages.isEmpty, state: modelPicker)
    }

    /// What the palette's composer commands read, so they re-register when it changes.
    private var commandsRevision: String {
        [session?.id, session?.model, session?.thinking, session?.state, "\(working)", "\(queuedMessages.count)",
         "\(session?.isSubscriptionPaused == true)", "\(modelPicker.models.models.count)", "\(hostAvailable)",
         "\(todos.count)", (session?.subagents ?? []).map(\.name).joined(separator: ",")]
            .map { $0 ?? "" }.joined(separator: "|")
    }

    /// The composer's controls for ⌘K, with the same availability as the controls themselves.
    private func composerCommandList() -> [ComposerCommand] {
        var commands: [ComposerCommand] = []
        let busy = working || !queuedMessages.isEmpty
        if let session, modelPicker.canPick(session: session, working: busy) {
            commands += ComposerCommandText.modelCommands(modelPicker.models.models, current: session.model) { model in
                modelPicker.pick(model, session: session, working: busy)
            }
            commands += ComposerCommandText.thinkingCommands(modelPicker.thinkingLevels(for: session),
                                                             current: session.thinking) { level in
                modelPicker.selectThinking(level, session: session, working: busy)
            }
        }
        if let onSchedule, hostAvailable {
            commands += ComposerCommandText.sendLater { when in
                // Checked when chosen: the draft may have changed since the palette opened.
                guard hostAvailable, state.canSend(changingModel: modelPicker.changing) else { return }
                onSchedule(state.attachments.message(text: state.trimmed), when)
            }
            commands.append(ComposerCommandText.sendLaterAtTime { state.scheduleAtTime += 1 })
        }
        if session != nil, !todos.isEmpty {
            commands.append(ComposerCommand(id: "tray-tasks", title: "Show or hide the task list",
                                            keywords: ["todo", "tasks", "tray", "progress"], icon: .tasks) {
                state.tasksToggle += 1
            })
        }
        if showsSubagents, let session {
            commands.append(ComposerCommand(id: "tray-subagents", title: "Show or hide the subagent list",
                                            keywords: ["subagents", "agents", "tray"], icon: .subagents) {
                state.subagentsToggle += 1
            })
            // As the tray rows do: the Agents tab on that subagent's transcript.
            let reference = hostContext?.ref(.session, session.id).storageKey ?? session.id
            for subagent in session.subagents ?? [] {
                commands.append(ComposerCommand(id: "subagent:\(subagent.name)", title: "Open subagent: \(subagent.name)",
                                                keywords: ["subagent", "agent", subagent.task], icon: .subagents) {
                    AppModel.shared.openSubagent(subagent.name, in: reference)
                })
            }
        }
        commands.append(ComposerCommandText.pasteImage { _ = state.attachments.paste(from: .general) })
        return commands
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
    let onAppCommand: ((SlashCommand) -> Void)?
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
            // Grows with a long draft up to 40% of the window, so the transcript keeps most of the room.
            ChatTextEditor(text: $state.draft, height: $state.height, font: fonts.nsBody, maxWindowFraction: 0.4,
                           focusToken: focusToken, onNavigateQueue: onNavigateQueue, onCancel: onCancel,
                           onPasteImages: onPasteImages, completionDirectory: completionDirectory,
                           slashCommands: slashCommands, onSlashCommandsNeeded: onSlashCommandsNeeded,
                           onAppCommand: onAppCommand,
                           onFocusChange: { [state] in state.onEditingChanged?($0) }, onSubmit: onSubmit)
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
                Button(action: onStop) { PilotSymbol(PilotIcon.stop, context: .toolbar) }
                    .buttonStyle(CircleIconButtonStyle(tint: Theme.destructive, foreground: .white))
                    .help("Stop the current run")
            }
            Button(action: onSend) { PilotSymbol(PilotIcon.send, context: .toolbar) }
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
    let schedule: (ScheduleWhen) -> Void

    var body: some View {
        SendLaterMenu(disabled: !state.canSend(changingModel: modelPicker.changing), schedule: schedule,
                      atTimeRequest: state.scheduleAtTime)
    }
}

/// The composer's key hints. The subagent composer in the Agents tab reuses them, so both read the same.
struct KeyHints: View {
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

/// The composer's working corner: the sidebar row's `DitherCorner` signal, limited to work. The agent's own run is
/// the full working ripple; a chat that still counts as working while its agent is idle (background jobs) uses the
/// background ripple, as its sidebar row does. Anything else, including needs-you states, draws nothing here.
struct ComposerCorner: Equatable {
    /// A tray is wider and taller than a row: more cells, the same 2 pt pixels.
    static let extent = 1.5

    var signal: SessionSignal?
    var background = false

    init(signal: SessionSignal?, background: Bool = false) {
        self.signal = signal
        self.background = background && signal == .working
    }

    init(agentWorking: Bool, session: SessionSummary?) {
        if session?.offlinePaused == true {
            self.init(signal: nil)
        } else if agentWorking {
            self.init(signal: .working)
        } else if let session, session.isWorking {
            self.init(signal: .working, background: session.isWaitingOnJobs)
        } else {
            self.init(signal: nil)
        }
    }
}
