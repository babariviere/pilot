import PilotCore
import SwiftUI

/// Live transcript for one session, fed by pilotd's agent event stream.
@MainActor
final class SessionFeed: ObservableObject {
    @Published private(set) var presentation: TranscriptPresentation
    @Published private(set) var loading = true
    private let sessionId: String
    private let client: PilotClient?
    private var token: UUID?
    private var processor = TranscriptProcessor()
    private var pending: [[JSONValue]] = []
    private var processing: Task<Void, Never>?
    private var generation = UUID()
    private var processorRevision = 0

    init(sessionId: String, client: PilotClient) {
        self.sessionId = sessionId
        self.client = client
        presentation = TranscriptPresentation()
    }

    /// A static transcript, for snapshots and previews.
    init(sessionId: String, transcript: Transcript) {
        self.sessionId = sessionId
        client = nil
        presentation = TranscriptPresentation(transcript: transcript)
        loading = false
    }

    func start() {
        guard let client, token == nil else { return }
        generation = UUID()
        processor = TranscriptProcessor()
        processorRevision = 0
        loading = true
        token = client.subscribe(sessionId) { [weak self] events in
            self?.enqueue(events)
        }
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
                guard var presentation = try? await processor.apply(events) else { return }
                guard !Task.isCancelled, self.generation == generation else { return }
                if presentation.revision != self.processorRevision {
                    self.processorRevision = presentation.revision
                    presentation.revision = self.presentation.revision + 1
                    self.presentation = presentation
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
    }
}

struct ChatView: View {
    let session: SessionSummary
    @StateObject private var feed: SessionFeed
    @StateObject private var composer: ComposerState

    init(session: SessionSummary, feed: SessionFeed? = nil, composer: ComposerState? = nil) {
        self.session = session
        _feed = StateObject(wrappedValue: feed ?? SessionFeed(sessionId: session.id, client: AppModel.shared.client))
        _composer = StateObject(wrappedValue: composer ?? ComposerState())
    }

    var body: some View {
        let transcript = feed.presentation
        let rows = transcript.rows
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if feed.loading, session.state != "failed" {
                        ProgressView(session.state == "starting" ? "Starting task…" : "Loading conversation…")
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(rows) { row in
                        RowView(row: row)
                    }
                    if transcript.working, !transcript.streaming || rows.last.map(isToolRow) == true {
                        WorkingIndicator(retry: transcript.retry)
                    }
                    if let error = session.error, transcript.error == nil {
                        ErrorRow(text: error)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 28)
                .padding(.top, 24)
                .padding(.bottom, 8)
                .frame(maxWidth: Theme.column + 56)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: transcript.revision) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if let usage = session.usage, usage.hasDisplayData { UsageFooter(usage: usage) }
                Composer(
                    state: composer,
                    working: transcript.working || session.state == "starting",
                    queuedMessages: transcript.queuedMessagesInDeliveryOrder,
                    onSend: send,
                    onStop: { Task { try? await AppModel.shared.client.stop(session.id) } },
                    onEditQueuedMessage: { id, text in
                        try await AppModel.shared.client.editQueuedMessage(session.id, submissionId: id, message: text)
                    }
                )
            }
        }
        .onAppear { feed.start() }
        .onDisappear { feed.stop() }
    }

    private func isToolRow(_ row: ChatRow) -> Bool {
        if case .tools = row { return true }
        return false
    }

    private func send(_ message: String, _ mode: DeliveryMode) {
        composer.error = nil
        let previous = composer.draft
        composer.draft = ""
        Task {
            do {
                try await AppModel.shared.client.send(session.id, message: message, mode: mode)
            } catch {
                composer.draft = previous
                composer.error = error.localizedDescription
            }
        }
    }
}

private struct RowView: View {
    let row: ChatRow

    var body: some View {
        switch row {
        case let .user(_, text):
            UserMessage(text: text)
        case let .text(_, text):
            MarkdownView(text: text)
        case let .thinking(_, text, streaming):
            ThinkingRow(text: text, streaming: streaming)
        case let .tools(_, items):
            ToolGroupView(items: items)
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

private struct UserMessage: View {
    @Environment(\.pilotFonts) private var fonts
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 72)
            Text(text)
                .font(fonts.body)
                .lineSpacing(3)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.muted))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
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

private struct WorkingIndicator: View {
    let retry: String?

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(retry.map { "Retrying: \($0)" } ?? "Working…")
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}
