import PilotCore
import SwiftUI

/// Live transcript for one session, fed by pilotd's agent event stream.
/// Rows publish through `rows`, observed only by the transcript's row views, and at most once per display frame.
/// The feed itself publishes `status`, which changes with a turn's state rather than per streamed token, so the
/// composer and the chat around the rows are not re-evaluated while text streams.
@MainActor
final class SessionFeed: ObservableObject {
    let rows: TranscriptRowsModel
    @Published private(set) var status: TranscriptStatus
    var presentation: TranscriptPresentation {
        get { rows.presentation }
        set {
            rows.presentation = newValue
            let next = TranscriptStatus(newValue)
            if next != status { status = next }
        }
    }
    @Published private(set) var loading = true
    @Published private(set) var hasSnapshot = false
    @Published private(set) var loadingEarlier = false
    @Published private(set) var earlierError: String?
    /// Messages just sent from an idle chat, shown until their committed user rows arrive.
    @Published private(set) var outgoing = OutgoingMessages()
    private let sessionId: String
    private let client: PilotClient?
    private var token: UUID?
    private var hostedContext: HostViewContext?
    private var releaseHosted: (() -> Void)?
    private var earlierLoad: Task<Void, Never>?
    private var outgoingExpiry: Task<Void, Never>?
    private var outgoingDeadline: Date?
    private var processor = TranscriptProcessor()
    private var pending: [[JSONValue]] = []
    private var processing: Task<Void, Never>?
    private var generation = UUID()
    private var processorRevision = 0
    /// The newest reduced state not yet published, and whether its batches held a snapshot or a failure.
    private var staged: TranscriptPresentation?
    private var stagedSnapshot = false
    private var stagedLoaded = false
    private lazy var pacer = DisplayFramePacer { [weak self] in self?.publishStaged() }
    var onPresentationChanged: (() -> Void)?
    var onEventsApplied: (([JSONValue]) -> Void)?
    var isSubscribed: Bool { token != nil || releaseHosted != nil }
    var cachedByteCount: Int { presentation.cachedByteCount }

    init(sessionId: String, client: PilotClient, initialPresentation: TranscriptPresentation = TranscriptPresentation()) {
        self.sessionId = sessionId
        self.client = client
        rows = TranscriptRowsModel(initialPresentation)
        status = TranscriptStatus(initialPresentation)
    }

    init(ref: HostResourceRef, hosts: HostClients, initialPresentation: TranscriptPresentation = TranscriptPresentation()) {
        sessionId = ref.localId
        client = nil
        hostedContext = HostViewContext(host: ref.host, hosts: hosts)
        rows = TranscriptRowsModel(initialPresentation)
        status = TranscriptStatus(initialPresentation)
    }

    /// A static transcript, for snapshots and previews.
    init(sessionId: String, transcript: Transcript) {
        self.sessionId = sessionId
        client = nil
        let presentation = TranscriptPresentation(transcript: transcript)
        rows = TranscriptRowsModel(presentation)
        status = TranscriptStatus(presentation)
        loading = false
        hasSnapshot = true
    }

    func start() {
        if let context = hostedContext {
            guard releaseHosted == nil else { return }
            loading = presentation.rows.isEmpty && context.available
            hasSnapshot = false
            releaseHosted = try? context.hosts.subscribe(context.ref(.session, sessionId)) { [weak self] events in
                self?.enqueue(events)
            }
            return
        }
        guard let client, token == nil else { return }
        generation = UUID()
        clearStaged()
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
        guard client == nil, hostedContext == nil else { return }
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
                guard let presentation = try? await StreamingTrace.measureAsync(.transcriptApply, {
                    try await processor.apply(events)
                }) else {
                    if self.generation == generation { self.processing = nil }
                    return
                }
                guard !Task.isCancelled, self.generation == generation else { return }
                self.onEventsApplied?(events)
                if presentation.revision != self.processorRevision {
                    self.processorRevision = presentation.revision
                    self.staged = presentation
                }
                if events.contains(where: { $0["type"]?.string == "snapshot" }) { self.stagedSnapshot = true }
                if events.contains(where: { ["snapshot", "task_failed"].contains($0["type"]?.string ?? "") }) {
                    self.stagedLoaded = true
                }
                self.pacer.request()
            }
            if let self, self.generation == generation { self.processing = nil }
        }
    }

    /// Publishes the newest reduced state, once per display frame at most.
    private func publishStaged() {
        guard staged != nil || stagedSnapshot || stagedLoaded else { return }
        let next = staged
        let snapshot = stagedSnapshot
        let loaded = stagedLoaded
        clearStaged()
        // Restoring a session's state on open is not a live change: without this, the queue
        // strip, todos and composer hints animate in as if they had just appeared.
        var transaction = Transaction()
        transaction.disablesAnimations = !hasSnapshot
        StreamingTrace.measure(.publish) {
            withTransaction(transaction) {
                if var next {
                    next.revision = presentation.revision + 1
                    presentation = next
                    onPresentationChanged?()
                    // Same transaction as the rows: the committed message replaces its stand-in in one frame.
                    reconcileOutgoing()
                }
                if snapshot { hasSnapshot = true }
                if loaded { loading = false }
            }
        }
    }

    private func clearStaged() {
        staged = nil
        stagedSnapshot = false
        stagedLoaded = false
        pacer.cancel()
    }

    func stop() {
        releaseHosted?(); releaseHosted = nil
        if let token { client?.unsubscribe(sessionId, token: token) }
        token = nil
        generation = UUID()
        clearStaged()
        processing?.cancel()
        processing = nil
        cancelEarlierLoad()
        pending.removeAll()
        // The cache retains prepared rows, not the reducer's duplicate history and tool state.
        processor = TranscriptProcessor()
        onPresentationChanged?()
    }

    /// Shows a sent message right away. Returns nil when it would only join the queue strip (a run is going).
    func addOutgoing(_ text: String) -> UUID? {
        guard hasSnapshot, !presentation.working, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return outgoing.add(text, to: presentation)
    }

    func acceptOutgoing(_ id: UUID) {
        outgoing.accept(id)
        reconcileOutgoing()
    }

    func removeOutgoing(_ id: UUID) {
        outgoing.remove(id)
        scheduleOutgoingExpiry()
    }

    /// Stop withdraws pending input into the composer, so nothing stands in for it any more.
    func clearOutgoing() {
        guard !outgoing.isEmpty else { return }
        outgoing.removeAll()
        scheduleOutgoingExpiry()
    }

    private func reconcileOutgoing() {
        guard !outgoing.isEmpty else { return }
        var next = outgoing
        if next.reconcile(with: presentation) { outgoing = next }
        scheduleOutgoingExpiry()
    }

    /// One timer for the earliest accepted message, instead of polling.
    private func scheduleOutgoingExpiry() {
        let deadline = outgoing.nextDeadline
        guard deadline != outgoingDeadline || outgoingExpiry == nil else { return }
        outgoingExpiry?.cancel()
        outgoingExpiry = nil
        outgoingDeadline = deadline
        guard let deadline else { return }
        let delay = max(0, deadline.timeIntervalSinceNow)
        outgoingExpiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.outgoingExpiry = nil
            self.reconcileOutgoing()
        }
    }

    /// Loads the next older page hidden by compaction. The page joins the event queue, so it is reduced
    /// off the main actor and in order with live events; a page for a stale cursor is ignored there.
    func loadEarlier() {
        guard isSubscribed, hasSnapshot, earlierLoad == nil, let before = presentation.earlierCursor else { return }
        let client = self.client
        let context = hostedContext
        let generation = generation
        loadingEarlier = true
        earlierError = nil
        earlierLoad = Task { [weak self, sessionId] in
            let result: Result<JSONValue, Error>
            do {
                if let context { result = .success(try await context.perform(.session, sessionId) { client, id in try await client.history(id, before: before) }) }
                else if let client { result = .success(try await client.history(sessionId, before: before)) }
                else { throw HostRoutingError.disconnected }
            }
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

    private let context: HostViewContext?
    @ObservedObject private var hosts = AppModel.shared.hosts
    @EndpointClient private var endpoint

    init(session: SessionSummary, feed: SessionFeed? = nil, composer: ComposerState? = nil, context: HostViewContext? = nil) {
        self.context = context
        self.session = session
        _feed = StateObject(wrappedValue: feed ?? context.map { AppModel.shared.feeds.feed(ref: $0.ref(.session, session.id), hosts: $0.hosts) } ?? AppModel.shared.feeds.feed(sessionId: session.id, client: AppModel.shared.client))
        _composerOwner = StateObject(wrappedValue: ChatComposerOwner(composer ?? context.flatMap { try? AppModel.shared.composer(for: $0.ref(.session, session.id)) } ?? AppModel.shared.composer(for: session.id)))
    }

    private var composer: ComposerState { composerOwner.state }
    /// Actions only. Observing the app model would re-evaluate the transcript for unrelated
    /// changes such as sidebar search or selection elsewhere.
    private var model: AppModel { AppModel.shared }

    var body: some View {
        let _ = Self.bodyEvaluations &+= 1
        let transcript = feed.status
        ScrollViewReader { proxy in
            ScrollView {
                // History already owns a lazy stack. Making its container lazy as well
                // treats the entire history as one estimated row, which can put the
                // bottom marker beyond every realized message on opening or resizing.
                VStack(alignment: .leading, spacing: 16) {
                    if session.isControl {
                        ControlChatHeader(title: session.title)
                            .frame(maxWidth: Theme.column, alignment: .leading)
                            .frame(maxWidth: .infinity)
                    }
                    if let origin = session.continuationOf {
                        ContinuedFromRow(originId: origin)
                            .frame(maxWidth: Theme.column, alignment: .leading)
                            .frame(maxWidth: .infinity)
                    }
                    if let context, !context.available {
                        DisconnectedNotice(context: context, historyCached: transcript.hasRows)
                            .frame(maxWidth: Theme.column).frame(maxWidth: .infinity)
                    }
                    if feed.loading, session.state != "failed", context?.available != false {
                        ProgressView(session.state == "starting" ? "Starting task…" : "Loading conversation…")
                            .frame(maxWidth: .infinity)
                    }
                    if transcript.earlierCursor != nil, feed.hasSnapshot {
                        EarlierMessagesRow(loading: feed.loadingEarlier, error: feed.earlierError, load: feed.loadEarlier)
                            .frame(maxWidth: Theme.column)
                            .frame(maxWidth: .infinity)
                    }
                    // The only part observing streamed rows; everything else here reads the turn's status.
                    TranscriptRowsSection(model: feed.rows, toolExpansions: toolExpansions,
                                          messageExpansions: messageExpansions)
                    // Sent messages show at once; the committed row replaces each in the same frame.
                    ForEach(feed.outgoing.messages) { message in
                        UserMessage(text: message.text)
                            .frame(maxWidth: Theme.column, alignment: .leading)
                            .frame(maxWidth: .infinity)
                            .transition(Theme.Motion.sent(reduceMotion: reduceMotion))
                    }
                    if let pauseNotice = session.pauseNoticeText {
                        Label(pauseNotice, icon: .paused)
                            .font(.pilot(.caption))
                            .foregroundStyle(Theme.mutedForeground)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: Theme.column, alignment: .leading)
                            .frame(maxWidth: .infinity)
                    } else if showsWorkingIndicator(transcript) {
                        WorkingIndicator(retry: transcript.retry, compacting: transcript.compacting,
                                         agentWorking: transcript.working || session.state == "starting"
                                             || !feed.outgoing.isEmpty,
                                         jobs: runningJobs, showJobs: { showingJobs.toggle() })
                            .frame(maxWidth: Theme.column, alignment: .leading)
                            .frame(maxWidth: .infinity)
                    }
                    if transcript.failureBannerText(for: session) != nil || session.canRetryStartup == true {
                        VStack(alignment: .leading, spacing: 8) {
                            if let error = transcript.failureBannerText(for: session) { ErrorRow(text: error) }
                            if session.canRetryStartup == true, !session.isReadOnlyHistory {
                                HStack(spacing: 8) {
                                    Button {
                                        retryingStartup = true
                                        composer.error = nil
                                        Task {
                                            defer { retryingStartup = false }
                                            do { try await perform { client, id in try await client.retryStartup(id) } }
                                            catch { composer.error = error.localizedDescription }
                                        }
                                    } label: {
                                        Label("Retry Startup", icon: PilotIcon.refresh)
                                    }
                                    .controlSize(.small)
                                    .accessibilityIdentifier("retry-startup")
                                    .disabled(retryingStartup)
                                    .help("Reload extensions and continue with the original queued messages. History and workspace files stay as they are.")
                                    Button("Stop Chat", action: stop)
                                        .controlSize(.small)
                                        .accessibilityIdentifier("stop-failed-recovery")
                                        .disabled(retryingStartup || model.pendingSessionActions.contains(session.id))
                                        .help("Cancel this chat and its saved subagent work without restarting the worker. History and workspace files stay as they are.")
                                }
                            }
                        }
                        .frame(maxWidth: Theme.column, alignment: .leading)
                        .frame(maxWidth: .infinity)
                    }
                    VStack(spacing: 0) {
                        if !session.isReadOnlyHistory {
                            // Pads itself only when it lists something, so an empty list adds no gap.
                            ScheduledMessages(sessionId: session.id, topPadding: 16)
                                .frame(maxWidth: Theme.column)
                                .frame(maxWidth: .infinity)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .background(ChatReviewVisibility {
                                guard !session.isWorking, session.outcome != nil,
                                      feed.hasSnapshot, !transcript.working, !transcript.streaming,
                                      model.hosts.selection == context?.ref(.session, session.id) || (context == nil && model.selectedSessionId == session.id) else { return }
                                if let context { model.review(session, on: context.host, chatVisible: true) } else { model.review(session, chatVisible: true) }
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
            .environment(\.transcriptRewind, session.isReadOnlyHistory ? nil : rewind)
            // New rows need no scroll request: while following, the native observer pins the bottom when the
            // document grows, within the same layout pass (TranscriptScrollObserver).
            .onChange(of: feed.outgoing.messages.count) { previous, count in
                // Sending is a request to see the conversation's end, even after reading back.
                guard count > previous else { return }
                scroll.follow.resumeFollowing()
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
                if let context, context.host != model.localHost {
                    OperationDeliveryNotice(ref: context.ref(.session, session.id), hosts: context.hosts,
                        adopt: { operation in try await model.adoptPendingMessage(operation, composer: composer) })
                        .padding(.horizontal, 24)
                }
                // The control chat works through its tools rather than handing context to a Build chat.
                if session.isAsk, !session.isControl {
                    // Matches the other rows above the composer, such as the queued-messages header.
                    HStack {
                        Button {
                            // Read at click time: the button's view does not observe streamed rows.
                            model.buildWithContext(from: session, rows: feed.presentation.rows, context: context)
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
                if showingJobs, !session.isReadOnlyHistory {
                    JobsPanel(sessionId: session.id, jobs: runningJobs) { showingJobs = false }
                }
                if !session.isArchived, let reason = session.attentionReason, reason.kind == .mcp {
                    // Matches the other rows above the composer, such as the Ask row above.
                    McpChatNotice(reason: reason)
                        .padding(.horizontal, 14)
                        .frame(maxWidth: Theme.column)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 2)
                }
                if session.isArchived {
                    ArchivedComposer(session: session)
                } else if let next = session.continuedTo {
                    // Work moved on, so this chat never resumes or takes messages.
                    ContinuedComposer(nextId: next)
                } else if let question = pendingQuestion(transcript) {
                    QuestionComposer(question: question, draft: composer.draftState, onSend: answer,
                                     onDecideAccess: decideDatabaseAccess)
                        .disabled(context?.available == false)
                        // Each question starts with nothing highlighted or ticked.
                        .id(question.entryID)
                        .transition(Theme.Motion.replacement(reduceMotion: reduceMotion))
                } else {
                    Composer(
                        state: composer,
                        working: transcript.working || session.state == "starting",
                        hostAvailable: context?.available ?? true,
                        rawAttachments: context != nil && context?.host != model.localHost,
                        queuedMessages: visibleQueuedMessages(transcript),
                        automaticInputs: transcript.automaticInputs,
                        completionDirectory: session.isAsk || (context != nil && context?.host != model.localHost) ? nil : session.cwd,
                        onSend: send,
                        onStop: { feed.clearOutgoing(); stop() },
                        onEditQueuedMessage: { id, text, mode in
                            try await perform { client, sessionId in try await client.editQueuedMessage(sessionId, submissionId: id, message: text, mode: mode) }
                        },
                        onRemoveQueuedMessage: { id in
                            try await perform { client, sessionId in try await client.removeQueuedMessage(sessionId, submissionId: id) }
                        },
                        onSendHeld: { try await perform { client, id in try await client.sendHeldMessages(id) } },
                        onDiscardHeld: { id in try await perform { client, sessionId in try await client.discardHeldMessages(sessionId, submissionId: id) } },
                        session: session,
                        todos: session.isAsk ? [] : transcript.todos,
                        slashCommands: slashCommands.commands,
                        onSlashCommandsNeeded: { [sessionId = session.id] in
                            slashCommands.load(sessionId: sessionId, client: endpoint)
                        },
                        onSchedule: session.isReadOnlyHistory || (context != nil && context?.host != model.localHost) ? nil : schedule,
                        context: context
                    )
                    .transition(Theme.Motion.replacement(reduceMotion: reduceMotion))
                }
            }
            .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: pendingQuestion(transcript)?.entryID)
            // The transcript scrolls behind this inset, including the gaps around its controls.
            .background(Theme.background)
        }
        // Opaque page behind the transcript. Without it the window background shows through, which macOS tints
        // with the wallpaper in dark appearance (an orange or olive cast instead of neutral grey).
        .background(Theme.background)
        .onAppear {
            feed.onEventsApplied = { [messageExpansions] in messageExpansions.applyMessageEvents($0) }
            feed.start()
        }
        .modifier(TranscriptRewindHost(
            rewind: rewind, feed: feed, composer: composer, sessionId: session.id,
            retryEntryID: session.isReadOnlyHistory ? nil : transcript.retryEntryID
        ))
        .onDisappear {
            feed.onEventsApplied = nil
            feed.stop(); scroll.cancelPreparedScroll(); preparedAction.action = nil
        }
    }

    private func perform<Value>(_ action: (PilotClient, String) async throws -> Value) async throws -> Value {
        if let context { return try await context.perform(.session, session.id, action) }
        return try await action(endpoint, session.id)
    }

    private func stop() {
        guard let context, context.host != model.localHost else { model.stopSession(session.id); return }
        Task {
            do {
                if let withdrawn = try await context.hosts.requestStop(context.ref(.session, session.id)), !withdrawn.isEmpty {
                    composer.draft = [composer.draft, withdrawn].filter { !$0.isEmpty }.joined(separator: "\n\n")
                    try model.persistDrafts()
                }
            } catch { composer.error = "Stop requested. Not yet confirmed. " + error.localizedDescription }
        }
    }

    /// "Working…" stays under the transcript for the whole run, including while text streams
    /// and tools run, so activity never looks like it stopped. A manual compaction can run
    /// while idle, so it shows too. A starting session shows it once the loading spinner is gone.
    /// Background jobs keep it after the agent's turn ends ("Waiting on 2 jobs · Tests 4m").
    private func showsWorkingIndicator(_ transcript: TranscriptStatus) -> Bool {
        transcript.working || transcript.compacting || (session.state == "starting" && !feed.loading)
            || !runningJobs.isEmpty || !feed.outgoing.isEmpty
    }

    /// A message on its way into the run already shows as its transcript bubble.
    private func visibleQueuedMessages(_ transcript: TranscriptStatus) -> [QueuedMessage] {
        let hidden = feed.outgoing.hiddenQueueIDs
        let messages = transcript.queuedMessagesInDeliveryOrder
        return hidden.isEmpty ? messages : messages.filter { !hidden.contains($0.id) }
    }

    /// Live from the session summary, which pilotd updates whenever the worker's jobs change.
    private var runningJobs: [SessionJob] { session.isArchived ? [] : session.runningJobs ?? [] }

    /// The agent's question replaces the composer once its run has ended.
    private func pendingQuestion(_ transcript: TranscriptStatus) -> AgentQuestion? {
        transcript.questionForComposer(session: session, hasSnapshot: feed.hasSnapshot)
    }

    private func answer(_ message: String) async throws {
        if let context, context.host != model.localHost {
            try await model.deliverMessage(context.ref(.session, session.id), text: message, mode: .steer, composer: composer, includeImages: false)
        } else { try await endpoint.send(session.id, message: message, mode: .steer) }
    }

    private func decideDatabaseAccess(_ access: AgentQuestion.DatabaseAccess, allow: Bool) async throws {
        try await perform { client, id in
            try await client.decideDatabaseAccess(id, requestId: access.id, allow: allow)
        }
    }

    private func send(_ message: String, _ mode: DeliveryMode) {
        guard !session.isReadOnlyHistory else { return }
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
        if let context, context.host != model.localHost {
            Task {
                do { try await model.deliverMessage(context.ref(.session, session.id), text: composer.trimmed, mode: mode, composer: composer) }
                catch { composer.error = error.localizedDescription }
            }
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
        let outgoing = withAnimation(Theme.Motion.standard(reduceMotion: reduceMotion)) { feed.addOutgoing(message) }
        Task {
            do {
                try await perform { client, id in try await client.send(id, message: message, mode: mode) }
                if let outgoing { feed.acceptOutgoing(outgoing) }
            } catch {
                if let outgoing { feed.removeOutgoing(outgoing) }
                composer.draft = [previous, composer.draft].filter { !$0.isEmpty }.joined(separator: "\n\n")
                composer.attachments.items.insert(contentsOf: previousAttachments.items, at: 0)
                composer.error = error.localizedDescription
            }
        }
    }

    /// Send later: clears the draft at once like send, and restores it if pilotd rejects the schedule.
    private func schedule(_ message: String, _ when: ScheduleWhen) {
        guard !session.isReadOnlyHistory else { return }
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
                _ = try await perform { client, _ in try await client.createSchedule(request) }
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
                try await perform { client, id in try await client.compact(id, instructions: instructions.isEmpty ? nil : instructions) }
            } catch {
                composer.draft = [previous, composer.draft].filter { !$0.isEmpty }.joined(separator: "\n\n")
                composer.error = error.localizedDescription
            }
        }
    }
}

/// The transcript's rows, published per streamed update (at most once per display frame). Only
/// `TranscriptRowsSection` observes it, so a token re-evaluates the rows, not the chat around them.
@MainActor
final class TranscriptRowsModel: ObservableObject {
    @Published fileprivate(set) var presentation: TranscriptPresentation

    init(_ presentation: TranscriptPresentation) {
        self.presentation = presentation
    }
}

/// History (one equatable subtree) and the live tail. Lays out as children of the transcript's stack.
struct TranscriptRowsSection: View {
    @ObservedObject var model: TranscriptRowsModel
    let toolExpansions: TranscriptExpansions
    let messageExpansions: TranscriptExpansions
    /// Offline performance checks report this next to ChatView's count.
    static var bodyEvaluations = 0

    var body: some View {
        let _ = Self.bodyEvaluations &+= 1
        let transcript = model.presentation
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
    @Environment(\.hostViewContext) private var hostContext
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
                SubagentAnswerRow(id: id, notification: notification, timestamp: timestamp,
                                  expansion: messageExpansions?.state(for: id))
            } else {
                UserMessage(text: text, expansion: messageExpansions?.state(for: id),
                            timestamp: timestamp, entryID: row.entryID)
                    .rewindMenu(for: row)
            }
        case let .automatic(id, text, origin, timestamp):
            if let notification = SubagentNotification(message: text) {
                SubagentAnswerRow(id: id, notification: notification, timestamp: timestamp,
                                  expansion: messageExpansions?.state(for: id))
            } else {
                ChatEventRow(event: .automatic(id: id, text: text, origin: origin, timestamp: timestamp),
                             expansion: messageExpansions?.state(for: id))
            }
        case let .text(id, text, timestamp):
            // Agent replies are always shown in full. Only user bubbles fold.
            MessageWithActions(text: text, milliseconds: timestamp) {
                MarkdownView(text: text, streaming: id.hasPrefix("streaming-"))
            }
                .rewindMenu(for: row)
        case let .work(id, group):
            WorkGroupView(id: id, group: group, active: active, toolExpansions: toolExpansions,
                          expansions: messageExpansions)
        case .thinking, .tools:
            // Transcripts fold these into work rows; a lone one still reads as a work line.
            WorkGroupView(id: row.id, group: TurnWork(rows: [row]), active: active, toolExpansions: toolExpansions,
                          expansions: messageExpansions)
        case let .artifact(_, reference):
            ArtifactCard(reference: reference, host: hostContext?.host)
        case let .question(id, question):
            ChatEventRow(event: .question(id: id, question: question), expansion: messageExpansions?.state(for: id))
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
    let text: String
    var expansion: ExpansionState? = nil
    var timestamp: Double? = nil
    var entryID: Int? = nil

    var body: some View {
        MessageWithActions(text: text, milliseconds: timestamp, trailing: true, entryID: entryID) {
            HStack {
                Spacer(minLength: 72)
                CollapsibleMessage(text: text, userBubble: true, expansion: expansion) {
                    MarkdownView(text: text, hugsContent: true)
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
                    .foregroundStyle(Theme.mutedForeground)
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
                    .foregroundStyle(Theme.error)
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
            .foregroundStyle(Theme.error)
            .frame(maxWidth: .infinity, alignment: .leading)
            if let entryID, let rewind {
                RetryButton(entryID: entryID, rewind: rewind)
            }
        }
        .font(.callout)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.destructive.opacity(0.1)))
    }
}
