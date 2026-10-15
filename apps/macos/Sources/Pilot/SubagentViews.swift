import PilotCore
import SwiftUI

/// One subagent's live, read-only transcript, streamed from pilotd. Shared by every view of that
/// subagent, so the popover and the Agents tab never open two streams.
@MainActor
final class SubagentFeed: ObservableObject {
    @Published private(set) var presentation = TranscriptPresentation()
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    let key: SubagentKey
    private let client: PilotClient
    private var token: UUID?
    private var processor = TranscriptProcessor()
    private var pending: [[JSONValue]] = []
    private var processing: Task<Void, Never>?
    private var generation = UUID()
    private var users = 0
    private var linger: Task<Void, Never>?
    /// Called once nothing has used the feed for `lingerDelay`, so the owner can drop it.
    var onIdle: (() -> Void)?
    var lingerDelay: Duration = .seconds(5)

    init(key: SubagentKey, client: PilotClient) {
        self.key = key
        self.client = client
    }

    var isActive: Bool { users > 0 || linger != nil }

    /// Views retain the feed while visible. The stream outlives a brief gap, such as popover to tab.
    func retain() {
        users += 1
        linger?.cancel()
        linger = nil
        guard token == nil else { return }
        generation = UUID()
        loading = true
        token = client.subscribeSubagent(key, PilotClient.SubagentListener(
            events: { [weak self] events in self?.enqueue(events) },
            error: { [weak self] message in
                self?.error = message
                self?.loading = false
            }
        ))
    }

    func release() {
        users = max(0, users - 1)
        guard users == 0, linger == nil else { return }
        linger = Task { [weak self] in
            try? await Task.sleep(for: self?.lingerDelay ?? .zero)
            guard !Task.isCancelled, let self, self.users == 0 else { return }
            self.linger = nil
            self.stop()
            self.onIdle?()
        }
    }

    private func stop() {
        if let token { client.unsubscribeSubagent(key, token: token) }
        token = nil
        generation = UUID()
        processing?.cancel()
        processing = nil
        pending.removeAll()
        processor = TranscriptProcessor()
    }

    private func enqueue(_ events: [JSONValue]) {
        // An empty batch means the subagent has no storage yet: replace with an empty transcript.
        if events.isEmpty || events.contains(where: { $0["type"]?.string == "snapshot" }) {
            processing?.cancel()
            processing = nil
            pending.removeAll()
            processor = TranscriptProcessor()
            generation = UUID()
            if events.isEmpty {
                presentation = TranscriptPresentation()
                loading = false
                error = nil
                return
            }
        }
        pending.append(events)
        guard processing == nil else { return }
        let generation = generation
        let processor = processor
        processing = Task { [weak self] in
            while let self, self.generation == generation, !self.pending.isEmpty {
                let batch = self.pending.flatMap { $0 }
                self.pending.removeAll(keepingCapacity: true)
                guard let presentation = try? await processor.apply(batch) else { break }
                guard !Task.isCancelled, self.generation == generation else { return }
                self.presentation = presentation
                self.loading = false
                self.error = nil
            }
            if let self, self.generation == generation { self.processing = nil }
        }
    }

    /// The latest tool calls and text, for compact previews.
    var recentActivity: [ChatRow] {
        Array(presentation.rows.flatMap(\.unfolded).filter {
            switch $0 {
            case .tools, .text, .error: true
            default: false
            }
        }.suffix(3))
    }
}

/// Live subagent feeds by session and name, dropped shortly after their last view disappears.
@MainActor
final class SubagentFeeds {
    private var feeds: [SubagentKey: SubagentFeed] = [:]

    func feed(_ key: SubagentKey, client: PilotClient) -> SubagentFeed {
        if let feed = feeds[key] { return feed }
        let feed = SubagentFeed(key: key, client: client)
        feed.onIdle = { [weak self, weak feed] in
            guard let self, let feed, self.feeds[key] === feed, !feed.isActive else { return }
            self.feeds[key] = nil
        }
        feeds[key] = feed
        return feed
    }

    var count: Int { feeds.count }
}

// MARK: - Status

struct SubagentStatusGlyph: View {
    let state: SubagentDisplayState

    var body: some View {
        Group {
            switch state {
            case .working:
                PilotSymbol(PilotIcon.working, context: .row)
            case .newAnswer:
                Circle().fill(Theme.success).frame(width: 7, height: 7)
            case .failed:
                Circle().fill(Theme.destructive).frame(width: 7, height: 7)
            case .idle:
                Circle().strokeBorder(Theme.mutedForeground.opacity(0.6), lineWidth: 1.2).frame(width: 7, height: 7)
            }
        }
        .frame(width: 12, height: 12)
        .accessibilityLabel(state.label)
    }
}

extension SubagentDisplayState {
    var color: Color {
        switch self {
        case .working: Theme.info
        case .newAnswer: Theme.success
        case .failed: Theme.destructive
        case .idle: Theme.mutedForeground
        }
    }
}

// MARK: - Strip above the composer

/// Subagents as one line at the top of the composer tray, shaped like `SystemMessagesStrip`: "2 subagents · 1 working".
/// Click it to open the Agents tab, which lists each one with its transcript and Stop.
struct SubagentsStrip: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let subagents = session.subagents ?? []
        let failed = subagents.filter(\.isFailed).count
        Button {
            model.inspectorTab = .agents
            model.inspectorVisible = true
        } label: {
            HStack(spacing: 8) {
                if subagents.contains(where: \.isWorking) {
                    PilotSymbol(PilotIcon.working).frame(width: 14)
                } else {
                    PilotSymbol(PilotIcon.subagents).foregroundStyle(Theme.faintForeground).frame(width: 14)
                }
                Text(subagents.count == 1 ? "1 subagent" : "\(subagents.count) subagents")
                    .font(.pilot(.label))
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
                    .fixedSize()
                let detail = summary(subagents)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.pilot(.label))
                        .foregroundStyle(Theme.faintForeground)
                        .lineLimit(1)
                }
                if failed > 0 {
                    // Failure is the one state here that needs the user.
                    Text("· \(failed) failed")
                        .font(.pilot(.label))
                        .foregroundStyle(Theme.destructive)
                        .lineLimit(1)
                        .fixedSize()
                }
                Spacer(minLength: 4)
                PilotSymbol(PilotIcon.disclosure, context: .disclosure)
                    .foregroundStyle(Theme.faintForeground)
                    .frame(width: 16, height: 16)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open the Agents tab")
        .accessibilityLabel(([subagents.count == 1 ? "1 subagent" : "\(subagents.count) subagents", summary(subagents)]
            + (failed > 0 ? ["\(failed) failed"] : [])).filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityHint("Opens the Agents tab")
    }

    /// Working and new counts after the total, each after a dot. Failures are shown on their own, in red.
    private func summary(_ subagents: [SessionSubagent]) -> String {
        let working = subagents.filter(\.isWorking).count
        let unread = model.unreadSubagents(in: session)
        return [
            working > 0 ? "\(working) working" : nil,
            unread > 0 ? "\(unread) new" : nil,
        ].compactMap { $0 }.map { "· " + $0 }.joined(separator: " ")
    }
}

/// Live activity for one subagent, with shortcuts to its transcript and Stop.
struct SubagentPopover: View {
    let session: SessionSummary
    let subagent: SessionSubagent
    let dismiss: () -> Void
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var feed: SubagentFeed

    init(session: SessionSummary, subagent: SessionSubagent, dismiss: @escaping () -> Void) {
        self.session = session
        self.subagent = subagent
        self.dismiss = dismiss
        feed = AppModel.shared.subagentFeed(session.id, subagent.name)
    }

    var body: some View {
        let display = SubagentDisplayState(subagent, unread: model.isUnread(subagent, in: session.id))
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                SubagentStatusGlyph(state: display)
                Text(subagent.name).font(.pilot(.body, weight: .semibold)).lineLimit(1)
                Text(display.label).font(.pilot(.caption, weight: .medium)).foregroundStyle(display.color)
                Spacer(minLength: 12)
                if subagent.isWorking {
                    Text(Date(timeIntervalSince1970: subagent.createdAt / 1000), style: .relative)
                        .font(.pilot(.caption).monospacedDigit())
                        .foregroundStyle(Theme.faintForeground)
                }
            }
            Text(subagent.task)
                .font(.pilot(.label))
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(3)
                .textSelection(.enabled)
            if let error = subagent.error {
                Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive).lineLimit(3)
            }
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                if feed.loading {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                } else if let error = feed.error {
                    Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive)
                } else if activity.isEmpty {
                    Text(subagent.isWorking ? "Starting…" : "No activity yet")
                        .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                } else {
                    ForEach(activity) { row in SubagentActivityLine(row: row) }
                }
                if subagent.isWorking && !feed.loading {
                    WorkingIndicator(retry: nil)
                }
            }
            HStack {
                Button("Open transcript") {
                    model.openSubagent(subagent.name, in: session.id)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                Spacer()
                if subagent.isWorking {
                    Button("Stop", role: .destructive) { model.stopSubagent(subagent.name, in: session.id) }
                        .disabled(model.pendingSessionActions.contains("\(session.id)/subagent/\(subagent.name)"))
                }
            }
            .controlSize(.small)
        }
        .padding(14)
        .frame(width: 380)
        .onAppear { feed.retain() }
        .onDisappear { feed.release() }
    }

    /// Recent rows, without repeating the failure already shown above.
    private var activity: [ChatRow] {
        feed.recentActivity.filter {
            if case let .error(_, text) = $0 { return text != subagent.error }
            return true
        }
    }
}

/// One compact line of recent activity: a tool call or the start of a reply.
private struct SubagentActivityLine: View {
    let row: ChatRow

    var body: some View {
        switch row {
        case let .tools(_, items):
            ForEach(items.suffix(3)) { item in
                let summary = item.summary
                HStack(spacing: 6) {
                    PilotSymbol(summary.icon.pilotIcon).frame(width: 12)
                    Text(summary.title).font(.pilot(.caption, weight: .medium))
                    if let detail = summary.detail {
                        Text(detail).font(.pilot(.caption, design: .monospaced)).foregroundStyle(Theme.faintForeground)
                    }
                }
                .foregroundStyle(item.status == .error ? Theme.destructive : Theme.mutedForeground)
                .lineLimit(1)
            }
        case let .text(_, text, _):
            Text(Self.inline(text)).font(.pilot(.label)).foregroundStyle(Theme.foreground).lineLimit(3)
        case let .error(_, text):
            Text(text).font(.pilot(.caption)).foregroundStyle(Theme.destructive).lineLimit(2)
        default:
            EmptyView()
        }
    }

    /// Inline emphasis and code only; block Markdown belongs in the full transcript.
    private static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

// MARK: - Agents inspector tab

/// Every subagent of a session, with the selected one's full transcript and controls.
struct SubagentsPane: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let subagents = session.subagents ?? []
        if subagents.isEmpty {
            EmptyStateView(icon: PilotIcon.subagents, title: "No subagents",
                           message: "Subagents this chat starts appear here, with their transcripts.")
                .padding(.horizontal, 16)
                .frame(maxHeight: .infinity)
        } else {
            let selected = subagents.first { $0.name == model.selectedSubagents[session.id] } ?? subagents[0]
            VStack(spacing: 0) {
                InspectorPaneHeader("\(subagents.count) subagent\(subagents.count == 1 ? "" : "s")")
                HStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(subagents) { subagent in row(subagent, selected: subagent.name == selected.name) }
                        }
                        .padding(6)
                    }
                    .frame(width: 170)
                    .background(Theme.sidebar)
                    Rectangle().fill(Theme.border).frame(width: 1)
                    SubagentDetail(session: session, subagent: selected)
                        .id(selected.name)
                }
            }
        }
    }

    private func row(_ subagent: SessionSubagent, selected: Bool) -> some View {
        let display = SubagentDisplayState(subagent, unread: model.isUnread(subagent, in: session.id))
        return Button { model.selectedSubagents[session.id] = subagent.name } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    SubagentStatusGlyph(state: display)
                    Text(subagent.name)
                        .font(.pilot(.label, weight: display == .newAnswer ? .semibold : .medium))
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                }
                Text(subagent.task)
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.faintForeground)
                    .lineLimit(1)
                    .padding(.leading, 14)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(selected ? Theme.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(subagent.name), \(display.label)")
    }
}

private struct SubagentDraft {
    var text = ""
    var sending = false
    var error: String?
}

private struct SubagentDetail: View {
    let session: SessionSummary
    let subagent: SessionSubagent
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var feed: SubagentFeed
    @State private var draft = SubagentDraft()

    init(session: SessionSummary, subagent: SessionSubagent) {
        self.session = session
        self.subagent = subagent
        feed = AppModel.shared.subagentFeed(session.id, subagent.name)
    }

    var body: some View {
        let display = SubagentDisplayState(subagent, unread: false)
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(subagent.name).font(.pilot(.body, weight: .semibold)).lineLimit(1)
                    Text(display.label).font(.pilot(.caption, weight: .medium)).foregroundStyle(display.color)
                    Spacer()
                    if subagent.isWorking {
                        Button("Stop", role: .destructive) { model.stopSubagent(subagent.name, in: session.id) }
                            .controlSize(.small)
                            .disabled(model.pendingSessionActions.contains("\(session.id)/subagent/\(subagent.name)"))
                    }
                }
                HStack(spacing: 10) {
                    if let modelName = subagent.model { meta(PilotIcon.model, modelName) }
                    meta(PilotIcon.project, URL(filePath: subagent.cwd).lastPathComponent)
                        .help(subagent.cwd.abbreviatingHome)
                    HStack(spacing: 3) {
                        PilotSymbol(PilotIcon.pending)
                        Text(Date(timeIntervalSince1970: subagent.createdAt / 1000), style: .relative)
                    }
                    .font(.pilot(.small))
                    .foregroundStyle(Theme.mutedForeground)
                }
                if let error = subagent.error {
                    Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive).textSelection(.enabled)
                }
            }
            .padding(12)
            Rectangle().fill(Theme.border).frame(height: 1)
            transcript
            Rectangle().fill(Theme.border).frame(height: 1)
            composer
        }
        .onAppear {
            feed.retain()
            model.markSubagentRead(subagent, in: session.id)
        }
        .onChange(of: subagent) { _, value in
            model.markSubagentRead(value, in: session.id)
        }
        .onDisappear { feed.release() }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if feed.loading {
                        ProgressView("Loading transcript…").controlSize(.small).frame(maxWidth: .infinity)
                    } else if let error = feed.error {
                        Text(error).font(.pilot(.label)).foregroundStyle(Theme.destructive)
                    } else if feed.presentation.rows.isEmpty {
                        Text(subagent.isWorking ? "Starting…" : "No messages yet.")
                            .font(.pilot(.label)).foregroundStyle(Theme.faintForeground)
                    }
                    let activeWork = subagent.isWorking ? feed.presentation.rows.last(where: \.isWork)?.id : nil
                    ForEach(feed.presentation.rows) { row in
                        RowView(row: row, active: row.id == activeWork).equatable()
                    }
                    if subagent.isWorking && !feed.loading {
                        WorkingIndicator(retry: nil)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(14)
            }
            .onChange(of: feed.presentation.rows.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error = draft.error {
                Text(error).font(.pilot(.caption)).foregroundStyle(Theme.destructive)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(
                    subagent.acceptsMessages ? "Message \(subagent.name)…" : "This subagent is retired",
                    text: $draft.text,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .font(.pilot(.label))
                .lineLimit(1 ... 6)
                .onSubmit { send(subagent.isWorking ? .steer : .followUp) }
                .disabled(!canMessage)
                if subagent.isWorking {
                    Button("Queue") { send(.followUp) }
                        .help("Deliver after the current work finishes")
                        .disabled(!canSend)
                }
                Button(subagent.isWorking ? "Steer" : "Send") { send(subagent.isWorking ? .steer : .followUp) }
                    .buttonStyle(.borderedProminent)
                    .help(subagent.isWorking ? "Redirect the current work now" : "Resume this subagent with a new message")
                    .disabled(!canSend)
            }
            .controlSize(.small)
            Text("Messages go to the subagent only. Its answer is delivered to this chat.")
                .font(.pilot(.small))
                .foregroundStyle(Theme.faintForeground)
        }
        .padding(10)
    }

    private var canMessage: Bool { subagent.acceptsMessages && !session.isReadOnlyHistory && !draft.sending }
    private var canSend: Bool { canMessage && !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func send(_ mode: DeliveryMode) {
        guard canSend else { return }
        let message = draft.text
        draft.sending = true
        draft.error = nil
        Task {
            defer { draft.sending = false }
            do {
                try await AppModel.shared.client.sendToSubagent(session.id, name: subagent.name, message: message, mode: mode)
                if draft.text == message { draft.text = "" }
            } catch {
                draft.error = error.localizedDescription
            }
        }
    }

    private func meta(_ icon: PilotIcon, _ text: String) -> some View {
        HStack(spacing: 3) {
            PilotSymbol(icon)
            Text(text).lineLimit(1)
        }
        .font(.pilot(.small))
        .foregroundStyle(Theme.mutedForeground)
    }
}

// MARK: - Answers delivered to the parent chat

/// A subagent answer or failure delivered to this chat, as a one-line event with Open beside Show.
struct SubagentAnswerRow: View {
    let id: String
    let notification: SubagentNotification
    var timestamp: Double? = nil
    var expansion: ExpansionState? = nil
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ChatEventRow(
            event: .subagent(id: id, notification: notification, timestamp: timestamp),
            expansion: expansion,
            action: model.selectedSessionId.map { sessionId in
                ChatEventRow.Action(label: "Open", help: "Open \(notification.name)'s transcript in the Agents tab") {
                    model.openSubagent(notification.name, in: sessionId)
                }
            }
        )
    }
}
