import PilotCore
import SwiftUI

/// Live transcript for one session, fed by pilotd's agent event stream.
@MainActor
final class SessionFeed: ObservableObject {
    @Published private(set) var presentation: TranscriptPresentation
    @Published private(set) var loading = true
    @Published private(set) var hasSnapshot = false
    private let sessionId: String
    private let client: PilotClient?
    private var token: UUID?
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
        cached.todos = []
        cached.working = false
        cached.streaming = false
        cached.retry = nil
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
            if let self, self.generation == generation { self.processing = nil }
        }
    }

    func stop() {
        if let token { client?.unsubscribe(sessionId, token: token) }
        token = nil
        generation = UUID()
        processing?.cancel()
        processing = nil
        pending.removeAll()
        // The cache retains prepared rows, not the reducer's duplicate history and tool state.
        processor = TranscriptProcessor()
        onPresentationChanged?()
    }
}

struct ChatView: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel
    @StateObject private var feed: SessionFeed
    @StateObject private var composerOwner: ChatComposerOwner
    @StateObject private var scroll = TranscriptScrollState()
    @StateObject private var preparedAction = TranscriptPreparedAction()
    @StateObject private var toolExpansions = TranscriptExpansions()
    @StateObject private var messageExpansions = TranscriptExpansions()
    private let bottomPadding: CGFloat = 8

    init(session: SessionSummary, feed: SessionFeed? = nil, composer: ComposerState? = nil) {
        self.session = session
        _feed = StateObject(wrappedValue: feed ?? AppModel.shared.feeds.feed(sessionId: session.id, client: AppModel.shared.client))
        _composerOwner = StateObject(wrappedValue: ChatComposerOwner(composer ?? AppModel.shared.composer(for: session.id)))
    }

    private var composer: ComposerState { composerOwner.state }

    var body: some View {
        let transcript = feed.presentation
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if feed.loading, session.state != "failed" {
                        ProgressView(session.state == "starting" ? "Starting task…" : "Loading conversation…")
                            .frame(maxWidth: .infinity)
                    }
                    if transcript.historyRowCount > 0 {
                        TranscriptHistoryRows(revision: transcript.historyRevision,
                            rows: transcript.historyRows[...], toolExpansions: toolExpansions,
                            messageExpansions: messageExpansions).equatable()
                    }
                    ForEach(transcript.liveRows) { row in
                        RowView(row: row, toolExpansions: toolExpansions,
                            messageExpansions: messageExpansions).equatable()
                    }
                    if transcript.working, !transcript.streaming ||
                        (transcript.liveRows.last ?? transcript.historyRows.last).map(isToolRow) == true {
                        WorkingIndicator(retry: transcript.retry)
                            .frame(maxWidth: Theme.column, alignment: .leading)
                            .frame(maxWidth: .infinity)
                    }
                    if let error = session.error, transcript.error == nil {
                        ErrorRow(text: error)
                            .frame(maxWidth: Theme.column, alignment: .leading)
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
                .padding(.horizontal, 28)
                .padding(.top, 24)
                .padding(.bottom, bottomPadding)
                .frame(maxWidth: .infinity)
                .background(TranscriptScrollObserver(state: scroll, bottomPadding: bottomPadding))
            }
            .environment(\.transcriptContentPrepared, preparedAction.callback)
            .environment(\.transcriptMessageToggled, scroll.messageToggled)
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
                    Button("Start a Build chat with this context") {
                        model.buildWithContext(from: session, rows: transcript.rows)
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(!feed.hasSnapshot || transcript.streaming)
                    .help("Prepare a separate Build draft with this discussion. This Ask chat stays read-only.")
                    .padding(.bottom, 6)
                }
                if !session.isAsk && !transcript.todos.isEmpty {
                    TodosPanel(todos: transcript.todos, sessionId: session.id)
                }
                if !session.isAsk {
                    SubagentsStrip(session: session)
                }
                if session.isArchived {
                    ArchivedComposer(session: session)
                } else {
                    Composer(
                        state: composer,
                        working: transcript.working || session.state == "starting",
                        queuedMessages: transcript.queuedMessagesInDeliveryOrder,
                        completionDirectory: session.isAsk ? nil : session.cwd,
                        onSend: send,
                        onStop: { model.stopSession(session.id) },
                        onEditQueuedMessage: { id, text in
                            try await AppModel.shared.client.editQueuedMessage(session.id, submissionId: id, message: text)
                        },
                        onRemoveQueuedMessage: { id in
                            try await AppModel.shared.client.removeQueuedMessage(session.id, submissionId: id)
                        },
                        session: session
                    )
                }
            }
        }
        .onAppear {
            feed.onEventsApplied = { [messageExpansions] in messageExpansions.applyMessageEvents($0) }
            feed.start()
        }
        .onDisappear {
            feed.onEventsApplied = nil
            feed.stop(); scroll.cancelPreparedScroll(); preparedAction.action = nil
        }
    }

    private func isToolRow(_ row: ChatRow) -> Bool {
        if case .tools = row { return true }
        return false
    }

    private func send(_ message: String, _ mode: DeliveryMode) {
        guard !session.isArchived else { return }
        composer.error = nil
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
    private let streamingGeneration: UUID?

    init(row: ChatRow, toolExpansions: TranscriptExpansions? = nil, messageExpansions: TranscriptExpansions? = nil) {
        self.row = row
        self.toolExpansions = toolExpansions
        self.messageExpansions = messageExpansions
        streamingGeneration = row.id.hasPrefix("streaming-") ? messageExpansions?.streamingGeneration : nil
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.toolExpansions === rhs.toolExpansions
            && lhs.messageExpansions === rhs.messageExpansions
            && lhs.streamingGeneration == rhs.streamingGeneration
    }

    private var maximumWidth: CGFloat {
        switch row {
        case .artifact: return .infinity
        case let .tools(_, items) where items.contains(where: { $0.artifact != nil }):
            return .infinity
        default: return Theme.column
        }
    }

    var body: some View {
        content
            .frame(maxWidth: maximumWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var content: some View {
        switch row {
        case let .user(id, text):
            if let notification = SubagentNotification(message: text) {
                SubagentAnswerRow(notification: notification)
            } else {
                UserMessage(text: text, expansion: messageExpansions?.state(for: id))
            }
        case let .text(id, text):
            if let expansion = messageExpansions?.state(for: id) {
                CollapsibleMessage(text: text, expansion: expansion) { MarkdownView(text: text) }
                    .id(ObjectIdentifier(expansion))
            } else {
                CollapsibleMessage(text: text) { MarkdownView(text: text) }
            }
        case let .thinking(_, text, streaming):
            ThinkingRow(text: text, streaming: streaming)
        case let .tools(_, items):
            ToolGroupView(items: items, expansions: toolExpansions)
        case let .artifact(_, reference):
            ArtifactCard(reference: reference)
        case let .error(_, text):
            ErrorRow(text: text)
        case let .notice(_, text):
            HStack {
                VStack { Divider() }
                Text(text).font(.caption).foregroundStyle(.secondary).fixedSize()
                VStack { Divider() }
            }
        }
    }
}

struct UserMessage: View {
    @Environment(\.pilotFonts) private var fonts
    let text: String
    var expansion: ExpansionState? = nil

    var body: some View {
        HStack {
            Spacer(minLength: 72)
            CollapsibleMessage(text: text, userBubble: true, expansion: expansion) {
                Text(text)
                    .font(fonts.body)
                    .lineSpacing(3)
                    .textSelection(.enabled)
            }
        }
        .padding(.top, 6)
    }
}

private struct ThinkingRow: View {
    let text: String
    let streaming: Bool
    @StateObject private var expansion = ExpansionState()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { expansion.expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain").font(.system(size: 11))
                    Text(streaming ? "Thinking…" : "Thought").font(.callout)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(expansion.expanded ? 90 : 0))
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expansion.expanded {
                MarkdownView(text: text)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 1).fill(.quaternary).frame(width: 2)
                    }
            }
        }
    }
}

private struct ErrorRow: View {
    let text: String

    var body: some View {
        Label {
            Text(text).textSelection(.enabled)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.callout)
        .foregroundStyle(.red)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.08)))
    }
}
