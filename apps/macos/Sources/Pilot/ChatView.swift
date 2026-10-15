import PilotCore
import SwiftUI

/// Live transcript for one session, fed by pilotd's agent event stream.
@MainActor
final class SessionFeed: ObservableObject {
    @Published private(set) var presentation: TranscriptPresentation
    @Published private(set) var loading = true
    @Published private(set) var hasSnapshot = false
    @Published private(set) var loadingEarlier = false
    @Published private(set) var earlierError: String?
    private let sessionId: String
    private let client: PilotClient?
    private var token: UUID?
    private var earlierLoad: Task<Void, Never>?
    private var processor = TranscriptProcessor()
    private var pending: [[JSONValue]] = []
    private var processing: Task<Void, Never>?
    private var generation = UUID()
    private var processorRevision = 0
    var onPresentationChanged: (() -> Void)?
    var onEventsApplied: (([JSONValue]) -> Void)?
    var isSubscribed: Bool { token != nil }
    var cachedByteCount: Int { presentation.cachedByteCount }

    init(sessionId: String, client: PilotClient, initialPresentation: TranscriptPresentation = TranscriptPresentation()) {
        self.sessionId = sessionId
        self.client = client
        presentation = initialPresentation
    }

    /// A static transcript, for snapshots and previews.
    init(sessionId: String, transcript: Transcript) {
        self.sessionId = sessionId
        client = nil
        presentation = TranscriptPresentation(transcript: transcript)
        loading = false
        hasSnapshot = true
    }

    func start() {
        guard let client, token == nil else { return }
        generation = UUID()
        processor = TranscriptProcessor()
        processorRevision = 0
        // Cached rows can paint immediately, but stale queue/status must not drive actions or review.
        loading = presentation.rows.isEmpty
        hasSnapshot = false
        var cached = presentation
        cached.queuedMessages = []
        cached.automaticInputs = []
        cached.todos = []
        cached.working = false
        cached.streaming = false
        cached.retry = nil
        cached.compacting = false
        cached.error = nil
        presentation = cached
        token = client.subscribe(sessionId) { [weak self] events in
            self?.enqueue(events)
        }
    }

    /// Offline performance fixtures use the production reduction/publication path without a socket.
    func applyFixtureEvents(_ events: [JSONValue]) {
        guard client == nil else { return }
        enqueue(events)
    }

    private func enqueue(_ events: [JSONValue]) {
        pending.append(events)
        guard processing == nil else { return }
        let generation = generation
        let processor = processor
        processing = Task { [weak self] in
            while let self, self.generation == generation, !self.pending.isEmpty {
                let events = self.pending.flatMap { $0 }
                self.pending.removeAll(keepingCapacity: true)
                guard var presentation = try? await processor.apply(events) else {
                    if self.generation == generation { self.processing = nil }
                    return
                }
                guard !Task.isCancelled, self.generation == generation else { return }
                self.onEventsApplied?(events)
                // Restoring a session's state on open is not a live change: without this, the queue
                // strip, todos and composer hints animate in as if they had just appeared.
                var transaction = Transaction()
                transaction.disablesAnimations = !self.hasSnapshot
                withTransaction(transaction) {
                    if presentation.revision != self.processorRevision {
                        self.processorRevision = presentation.revision
                        presentation.revision = self.presentation.revision + 1
                        self.presentation = presentation
                        self.onPresentationChanged?()
                    }
                    if events.contains(where: { $0["type"]?.string == "snapshot" }) {
                        self.hasSnapshot = true
                    }
                    if events.contains(where: { ["snapshot", "task_failed"].contains($0["type"]?.string ?? "") }) {
                        self.loading = false
                    }
                }
            }
            if let self, self.generation == generation { self.processing = nil }
        }
    }

    func stop() {
        if let token { client?.unsubscribe(sessionId, token: token) }
        token = nil
        generation = UUID()
        processing?.cancel()
        processing = nil
        cancelEarlierLoad()
        pending.removeAll()
        // The cache retains prepared rows, not the reducer's duplicate history and tool state.
        processor = TranscriptProcessor()
        onPresentationChanged?()
    }

    /// Loads the next older page hidden by compaction. The page joins the event queue, so it is reduced
    /// off the main actor and in order with live events; a page for a stale cursor is ignored there.
    func loadEarlier() {
        guard let client, token != nil, hasSnapshot, earlierLoad == nil, let before = presentation.earlierCursor else { return }
        let generation = generation
        loadingEarlier = true
        earlierError = nil
        earlierLoad = Task { [weak self, sessionId] in
            let result: Result<JSONValue, Error>
            do { result = .success(try await client.history(sessionId, before: before)) }
            catch { result = .failure(error) }
            guard let self, !Task.isCancelled, self.generation == generation else { return }
            self.earlierLoad = nil
            self.loadingEarlier = false
            switch result {
            case let .success(page): self.enqueue([Transcript.earlierEntries(before: before, page: page)])
            case let .failure(error): self.earlierError = error.localizedDescription
            }
        }
    }

    private func cancelEarlierLoad() {
        earlierLoad?.cancel()
        earlierLoad = nil
        loadingEarlier = false
        earlierError = nil
    }
}

struct ChatView: View {
    let session: SessionSummary
    @StateObject private var feed: SessionFeed
    @StateObject private var composerOwner: ChatComposerOwner
    @StateObject private var scroll = TranscriptScrollState()
    @StateObject private var preparedAction = TranscriptPreparedAction()
    @StateObject private var toolExpansions = TranscriptExpansions()
    @StateObject private var messageExpansions = TranscriptExpansions()
    @StateObject private var slashCommands = SlashCommandSource()
    @StateObject private var rewind = TranscriptRewind()
    @State private var showingJobs = false
    @State private var retryingStartup = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let bottomPadding: CGFloat = 8
    /// Offline performance checks report this, so redundant transcript invalidations are countable.
    static var bodyEvaluations = 0

    init(session: SessionSummary, feed: SessionFeed? = nil, composer: ComposerState? = nil) {
        self.session = session
        _feed = StateObject(wrappedValue: feed ?? AppModel.shared.feeds.feed(sessionId: session.id, client: AppModel.shared.client))
        _composerOwner = StateObject(wrappedValue: ChatComposerOwner(composer ?? AppModel.shared.composer(for: session.id)))
    }

    private var composer: ComposerState { composerOwner.state }
    /// Actions only. Observing the app model would re-evaluate the transcript for unrelated
    /// changes such as sidebar search or selection elsewhere.
    private var model: AppModel { AppModel.shared }

    var body: some View {
        let _ = Self.bodyEvaluations &+= 1
        let transcript = feed.presentation
        ScrollViewReader { proxy in
            ScrollView {
                // History already owns a lazy stack. Making its container lazy as well
                // treats the entire history as one estimated row, which can put the
                // bottom marker beyond every realized message on opening or resizing.
                VStack(alignment: .leading, spacing: 16) {
                    if feed.loading, session.state != "failed" {
                        ProgressView(session.state == "starting" ? "Starting task…" : "Loading conversation…")
                            .frame(maxWidth: .infinity)
                    }
                    if transcript.earlierCursor != nil, feed.hasSnapshot {
                        EarlierMessagesRow(loading: feed.loadingEarlier, error: feed.earlierError, load: feed.loadEarlier)
                            .frame(maxWidth: Theme.column)
                            .frame(maxWidth: .infinity)
                    }
                    if transcript.historyRowCount > 0 {
                        TranscriptHistoryRows(revision: transcript.historyRevision,
                            rows: transcript.historyRows[...], toolExpansions: toolExpansions,
                            messageExpansions: messageExpansions).equatable()
                    }
                    let activeWork = transcript.working ? transcript.liveRows.last(where: \.isWork)?.id : nil
                    ForEach(transcript.liveRows) { row in
                        RowView(row: row, toolExpansions: toolExpansions,
                            messageExpansions: messageExpansions, active: row.id == activeWork).equatable()
                    }
                    if showsWorkingIndicator(transcript) {
                        WorkingIndicator(retry: transcript.retry, compacting: transcript.compacting,
                                         agentWorking: transcript.working || session.state == "starting",
                                         jobs: runningJobs, showJobs: { showingJobs.toggle() })
                            .frame(maxWidth: Theme.column, alignment: .leading)
                            .frame(maxWidth: .infinity)
                    }
                    if let error = transcript.failureBannerText(for: session) {
                        VStack(alignment: .leading, spacing: 8) {
                            ErrorRow(text: error)
                            if session.canRetryStartup == true, !session.isArchived {
                                Button {
                                    retryingStartup = true
                                    composer.error = nil
                                    Task {
                                        defer { retryingStartup = false }
                                        do { try await model.client.retryStartup(session.id) }
                                        catch { composer.error = error.localizedDescription }
                                    }
                                } label: {
                                    Label("Retry Startup", icon: PilotIcon.refresh)
                                }
                                .controlSize(.small)
                                .accessibilityIdentifier("retry-startup")
                                .disabled(retryingStartup)
                                .help("Reload extensions and continue with the original queued messages. History and workspace files stay as they are.")
                            }
                        }
                        .frame(maxWidth: Theme.column, alignment: .leading)
                        .frame(maxWidth: .infinity)
                    }
                    VStack(spacing: 0) {
                        if !session.isArchived {
                            // Pads itself only when it lists something, so an empty list adds no gap.
                            ScheduledMessages(sessionId: session.id, topPadding: 16)
                                .frame(maxWidth: Theme.column)
                                .frame(maxWidth: .infinity)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .background(ChatReviewVisibility {
                                guard !session.isWorking, session.outcome != nil,
                                      feed.hasSnapshot, !transcript.working, !transcript.streaming,
                                      model.selectedSessionId == session.id else { return }
                                model.review(session, chatVisible: true)
                            })
                    }
                }
                .padding(.horizontal, 28)
                .padding(.top, 24)
                .padding(.bottom, bottomPadding)
                .frame(maxWidth: .infinity)
                .background(TranscriptScrollObserver(state: scroll, bottomPadding: bottomPadding))
            }
            .environment(\.transcriptContentPrepared, preparedAction.callback)
            .environment(\.transcriptMessageToggled, scroll.messageToggled)
            .environment(\.transcriptRewind, session.isArchived ? nil : rewind)
            .onChange(of: transcript.revision) { _, _ in
                guard scroll.follow.shouldScrollToBottom else { return }
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onAppear {
                let state = scroll
                preparedAction.action = { state.contentPrepared { proxy.scrollTo("bottom", anchor: .bottom) } }
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if session.isAsk {
                    // Matches the other rows above the composer, such as the queued-messages header.
                    HStack {
                        Button {
                            model.buildWithContext(from: session, rows: transcript.rows)
                        } label: {
                            Label("Start a Build chat with this context", icon: PilotIcon.buildMode)
                        }
                        .buttonStyle(.link)
                        .font(.pilot(.caption))
                        .disabled(!feed.hasSnapshot || transcript.streaming)
                        .help("Prepare a separate Build draft with this discussion. This Ask chat stays read-only.")
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .frame(maxWidth: Theme.column)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 2)
                }
                if !session.isAsk && !transcript.todos.isEmpty {
                    TodosPanel(todos: transcript.todos, sessionId: session.id)
                }
                if !session.isAsk {
                    SubagentsStrip(session: session)
                }
                if showingJobs, !session.isArchived {
                    JobsPanel(sessionId: session.id, jobs: runningJobs) { showingJobs = false }
                }
                if session.isArchived {
                    ArchivedComposer(session: session)
                } else if let question = pendingQuestion(transcript) {
                    QuestionComposer(question: question, draft: composer.draftState, onSend: answer)
                        // Each question starts with nothing highlighted or ticked.
                        .id(question.entryID)
                        .transition(Theme.Motion.replacement(reduceMotion: reduceMotion))
                } else {
                    Composer(
                        state: composer,
                        working: transcript.working || session.state == "starting",
                        queuedMessages: transcript.queuedMessagesInDeliveryOrder,
                        automaticInputs: transcript.automaticInputs,
                        completionDirectory: session.isAsk ? nil : session.cwd,
                        onSend: send,
                        onStop: { model.stopSession(session.id) },
                        onEditQueuedMessage: { id, text, mode in
                            try await AppModel.shared.client.editQueuedMessage(
                                session.id, submissionId: id, message: text, mode: mode
                            )
                        },
                        onRemoveQueuedMessage: { id in
                            try await AppModel.shared.client.removeQueuedMessage(session.id, submissionId: id)
                        },
                        onSendHeld: { try await AppModel.shared.client.sendHeldMessages(session.id) },
                        onDiscardHeld: { id in try await AppModel.shared.client.discardHeldMessages(session.id, submissionId: id) },
                        session: session,
                        slashCommands: slashCommands.commands,
                        onSlashCommandsNeeded: { [sessionId = session.id] in
                            slashCommands.load(sessionId: sessionId, client: AppModel.shared.client)
                        },
                        onSchedule: session.isArchived ? nil : schedule
                    )
                    .transition(Theme.Motion.replacement(reduceMotion: reduceMotion))
                }
            }
            .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: pendingQuestion(transcript)?.entryID)
            // The transcript scrolls behind this inset, including the gaps around its controls.
            .background(Theme.background)
        }
        .onAppear {
            feed.onEventsApplied = { [messageExpansions] in messageExpansions.applyMessageEvents($0) }
            feed.start()
        }
        .modifier(TranscriptRewindHost(
            rewind: rewind, feed: feed, composer: composer, sessionId: session.id,
            retryEntryID: session.isArchived ? nil : transcript.retryEntryID
        ))
        .onDisappear {
            feed.onEventsApplied = nil
            feed.stop(); scroll.cancelPreparedScroll(); preparedAction.action = nil
        }
    }

    /// "Working…" stays under the transcript for the whole run, including while text streams
    /// and tools run, so activity never looks like it stopped. A manual compaction can run
    /// while idle, so it shows too. A starting session shows it once the loading spinner is gone.
    /// Background jobs keep it after the agent's turn ends ("Waiting on 2 jobs · Tests 4m").
    private func showsWorkingIndicator(_ transcript: TranscriptPresentation) -> Bool {
        transcript.working || transcript.compacting || (session.state == "starting" && !feed.loading)
            || !runningJobs.isEmpty
    }

    /// Live from the session summary, which pilotd updates whenever the worker's jobs change.
    private var runningJobs: [SessionJob] { session.isArchived ? [] : session.runningJobs ?? [] }

    /// The agent's question replaces the composer once its run has ended.
    private func pendingQuestion(_ transcript: TranscriptPresentation) -> AgentQuestion? {
        guard feed.hasSnapshot, !transcript.working, session.state != "starting", !session.isWorking else { return nil }
        return transcript.pendingQuestion
    }

    private func answer(_ message: String) async throws {
        try await AppModel.shared.client.send(session.id, message: message, mode: .steer)
    }

    private func send(_ message: String, _ mode: DeliveryMode) {
        guard !session.isArchived else { return }
        composer.error = nil
        if let arguments = SlashCommands.jobsArguments(composer.trimmed) {
            guard arguments.isEmpty else {
                composer.error = "Use /jobs without arguments."
                return
            }
            guard composer.attachments.items.isEmpty else {
                composer.error = "Remove attached images to run /jobs."
                return
            }
            composer.draft = ""
            showingJobs = true
            return
        }
        if let instructions = SlashCommands.compactInstructions(composer.trimmed) {
            compact(instructions)
            return
        }
        let previous = composer.draft
        do { try composer.attachments.retainForHistory() }
        catch {
            composer.error = "Could not retain attached images: \(error.localizedDescription)"
            return
        }
        let previousAttachments = composer.attachments
        composer.draft = ""
        composer.attachments = ImageAttachments()
        Task {
            do {
                try await AppModel.shared.client.send(session.id, message: message, mode: mode)
            } catch {
                composer.draft = [previous, composer.draft].filter { !$0.isEmpty }.joined(separator: "\n\n")
                composer.attachments.items.insert(contentsOf: previousAttachments.items, at: 0)
                composer.error = error.localizedDescription
            }
        }
    }

    /// Send later: clears the draft at once like send, and restores it if pilotd rejects the schedule.
    private func schedule(_ message: String, _ when: ScheduleWhen) {
        guard !session.isArchived else { return }
        composer.error = nil
        guard SlashCommands.jobsArguments(composer.trimmed) == nil else {
            composer.error = "Run /jobs now instead of scheduling it."
            return
        }
        let previous = composer.draft
        do { try composer.attachments.retainForHistory() }
        catch {
            composer.error = "Could not retain attached images: \(error.localizedDescription)"
            return
        }
        let previousAttachments = composer.attachments
        composer.draft = ""
        composer.attachments = ImageAttachments()
        let request = ScheduleRequest(
            title: ScheduleText.title(previous, fallback: "Follow-up message"), trigger: when.trigger, at: when.at,
            target: .message(sessionId: session.id, message: message)
        )
        Task {
            do {
                _ = try await AppModel.shared.client.createSchedule(request)
            } catch {
                composer.draft = [previous, composer.draft].filter { !$0.isEmpty }.joined(separator: "\n\n")
                composer.attachments.items.insert(contentsOf: previousAttachments.items, at: 0)
                composer.error = error.localizedDescription
            }
        }
    }

    /// `/compact [instructions]` is handled by Pilot, never sent to the agent as a message.
    private func compact(_ instructions: String) {
        guard composer.attachments.items.isEmpty else {
            composer.error = "Remove attached images to run /compact."
            return
        }
        let previous = composer.draft
        composer.draft = ""
        Task {
            do {
                try await AppModel.shared.client.compact(session.id, instructions: instructions.isEmpty ? nil : instructions)
            } catch {
                composer.draft = [previous, composer.draft].filter { !$0.isEmpty }.joined(separator: "\n\n")
                composer.error = error.localizedDescription
            }
        }
    }
}

/// One equatable layout subtree, rather than diffing the historical ForEach on each token.
/// Equality uses the processor's key, never the history-sized row collection.
struct TranscriptHistoryRows: View, Equatable {
    let revision: UUID
    let rows: ArraySlice<ChatRow>
    var toolExpansions: TranscriptExpansions? = nil
    var messageExpansions: TranscriptExpansions? = nil

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.revision == rhs.revision && lhs.rows.count == rhs.rows.count
            && lhs.toolExpansions === rhs.toolExpansions && lhs.messageExpansions === rhs.messageExpansions
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(rows) { row in
                RowView(row: row, toolExpansions: toolExpansions, messageExpansions: messageExpansions).equatable()
                    // Row geometry for scroll anchoring; see ScrollObserverView.
                    .background(TranscriptRowAnchor(id: row.id))
            }
        }
    }
}

/// A stable environment closure prevents unrelated Markdown descendants from being invalidated
/// merely because ChatView supplies a newly allocated scroll callback on every streamed value.
@MainActor
private final class TranscriptPreparedAction: ObservableObject {
    var action: (() -> Void)?
    lazy var callback: () -> Void = { [weak self] in self?.action?() }
}

struct RowView: View, Equatable {
    let row: ChatRow
    let toolExpansions: TranscriptExpansions?
    let messageExpansions: TranscriptExpansions?
    /// A work row of the running turn: open, with its latest steps.
    let active: Bool
    private let streamingGeneration: UUID?

    init(row: ChatRow, toolExpansions: TranscriptExpansions? = nil, messageExpansions: TranscriptExpansions? = nil,
         active: Bool = false) {
        self.row = row
        self.toolExpansions = toolExpansions
        self.messageExpansions = messageExpansions
        self.active = active
        streamingGeneration = row.id.hasPrefix("streaming-") || row.isWork ? messageExpansions?.streamingGeneration : nil
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.active == rhs.active && lhs.toolExpansions === rhs.toolExpansions
            && lhs.messageExpansions === rhs.messageExpansions
            && lhs.streamingGeneration == rhs.streamingGeneration
    }

    var body: some View {
        content
            .frame(maxWidth: Theme.column, alignment: .leading)
            .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var content: some View {
        switch row {
        case let .user(id, text, timestamp):
            if let notification = SubagentNotification(message: text) {
                SubagentAnswerRow(notification: notification)
            } else {
                UserMessage(text: text, expansion: messageExpansions?.state(for: id),
                            timestamp: timestamp, entryID: row.entryID)
                    .rewindMenu(for: row)
            }
        case let .automatic(id, text, origin, timestamp):
            if let notification = SubagentNotification(message: text) {
                SubagentAnswerRow(notification: notification)
            } else {
                MessageWithActions(text: text, milliseconds: timestamp) {
                    AutomaticMessageRow(text: text, origin: origin, expansion: messageExpansions?.state(for: id))
                }
            }
        case let .text(_, text, timestamp):
            // Agent replies are always shown in full. Only user bubbles fold.
            MessageWithActions(text: text, milliseconds: timestamp) { MarkdownView(text: text) }
                .rewindMenu(for: row)
        case let .work(id, group):
            WorkGroupView(id: id, group: group, active: active, toolExpansions: toolExpansions,
                          expansions: messageExpansions)
        case .thinking, .tools:
            // Transcripts fold these into work rows; a lone one still reads as a work line.
            WorkGroupView(id: row.id, group: TurnWork(rows: [row]), active: active, toolExpansions: toolExpansions,
                          expansions: messageExpansions)
        case let .artifact(_, reference):
            ArtifactCard(reference: reference)
        case let .question(_, question):
            QuestionRow(question: question)
        case let .error(_, text):
            ErrorRow(text: text, entryID: row.entryID)
        case let .notice(id, text):
            ChatEventRow(event: ChatEvent(id: id, kind: "activity", text: text))
        case let .event(event):
            ChatEventRow(event: event, expansion: messageExpansions?.state(for: event.id))
        }
    }
}

struct UserMessage: View {
    @Environment(\.pilotFonts) private var fonts
    let text: String
    var expansion: ExpansionState? = nil
    var timestamp: Double? = nil
    var entryID: Int? = nil

    var body: some View {
        MessageWithActions(text: text, milliseconds: timestamp, trailing: true, entryID: entryID) {
            HStack {
                Spacer(minLength: 72)
                CollapsibleMessage(text: text, userBubble: true, expansion: expansion) {
                    Text(text)
                        .font(fonts.body)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(.top, 6)
    }
}

/// Top of a transcript whose older messages were compacted out of the agent's context. They stay in storage and
/// load a page at a time; scroll anchoring keeps the rows the reader was looking at in place.
private struct EarlierMessagesRow: View {
    let loading: Bool
    let error: String?
    let load: () -> Void

    var body: some View {
        VStack(spacing: 4) {
            HStack {
                VStack { Divider() }
                if loading {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Loading earlier messages…")
                    }
                    .font(.pilot(.caption))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                } else {
                    Button(error == nil ? "Show earlier messages" : "Retry loading earlier messages", action: load)
                        .buttonStyle(.link)
                        .font(.pilot(.caption))
                        .fixedSize()
                        .help("Messages from before the context was compacted. The agent no longer sees them.")
                }
                VStack { Divider() }
            }
            if let error, !loading {
                Text(error)
                    .font(.pilot(.caption))
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct ErrorRow: View {
    let text: String
    var entryID: Int? = nil
    @Environment(\.transcriptRewind) private var rewind

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Label {
                Text(text).textSelection(.enabled)
            } icon: {
                PilotSymbol(PilotIcon.warning)
            }
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            if let entryID, let rewind {
                RetryButton(entryID: entryID, rewind: rewind)
            }
        }
        .font(.callout)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Color.red.opacity(0.08)))
    }
}
