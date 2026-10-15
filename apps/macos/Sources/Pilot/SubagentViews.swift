import PilotCore
import SwiftUI

/// One subagent's live, read-only transcript, streamed from pilotd. Shared by every view of that
/// subagent, so reopening its detail view never opens a second stream.
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

    /// Views retain the feed while visible. The stream outlives a brief gap, such as list to detail and back.
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

// MARK: - Strip above the composer

/// Subagents as one line at the top of the composer tray, shaped like `SystemMessagesStrip`: "3 subagents", with the
/// working spinner while any of them works and failures in red. Click it to open the Agents tab's list.
struct SubagentsStrip: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let subagents = session.subagents ?? []
        let failed = subagents.filter(\.isFailed).count
        let working = subagents.contains(where: \.isWorking)
        let title = subagents.count == 1 ? "1 subagent" : "\(subagents.count) subagents"
        Button {
            model.selectedSubagents[session.id] = nil
            model.inspectorTab = .agents
            model.inspectorVisible = true
        } label: {
            HStack(spacing: 8) {
                Group {
                    if working {
                        DotGridSpinner()
                    } else {
                        PilotSymbol(PilotIcon.subagents).foregroundStyle(Theme.faintForeground)
                    }
                }
                .frame(width: 14)
                Text(title)
                    .font(.pilot(.label))
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
                    .fixedSize()
                if failed > 0 {
                    // Failure is the one subagent state that needs the user.
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
        .accessibilityLabel(([title] + (working ? ["working"] : []) + (failed > 0 ? ["\(failed) failed"] : []))
            .joined(separator: ", "))
        .accessibilityHint("Opens the Agents tab")
    }
}

// MARK: - Agents inspector tab

extension SessionSubagent {
    /// The sidebar's corner vocabulary for a subagent row: the working ripple or failed red. An unread answer is not
    /// something the user must act on, so idle subagents draw no corner.
    var cornerSignal: SessionSignal? {
        if isWorking { return .working }
        if isFailed { return .failed }
        return nil
    }
}

/// Every subagent of a session as one list. Clicking a row opens its detail view (transcript and composer) in place,
/// with a back button to the list. `AppModel.selectedSubagents` holds the open subagent per chat; nil shows the list.
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
        } else if let name = model.selectedSubagents[session.id],
                  let selected = subagents.first(where: { $0.name == name }) {
            SubagentDetail(session: session, subagent: selected) { model.selectedSubagents[session.id] = nil }
                .id(selected.name)
        } else {
            VStack(spacing: 0) {
                InspectorPaneHeader("\(subagents.count) subagent\(subagents.count == 1 ? "" : "s")")
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(subagents.enumerated()), id: \.element.id) { index, subagent in
                            if index > 0 { HairlineDivider(leading: InboxRowLayout.dividerInset) }
                            SubagentRow(subagent: subagent) { model.openSubagent(subagent.name, in: session.id) }
                                .inboxCorner(subagent.cornerSignal)
                        }
                    }
                    .padding(8)
                }
                .frame(maxHeight: .infinity)
            }
        }
    }
}

/// One subagent in the Agents list: its name and task. The row's dithered corner carries its state.
private struct SubagentRow: View {
    let subagent: SessionSubagent
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HoverRow(verticalPadding: 7) { _ in
                InboxRowLabel(title: subagent.name) {
                    Text(subagent.task)
                        .font(.pilot(.caption))
                        .foregroundStyle(Theme.mutedForeground)
                        .lineLimit(1)
                } trailing: {
                    EmptyView()
                }
            }
        }
        .rowButtonStyle()
        .help(subagent.task)
        .accessibilityLabel("\(subagent.name), \(SubagentDisplayState(subagent, unread: false).label). \(subagent.task)")
        .accessibilityHint("Opens its transcript")
    }
}

private struct SubagentDraft {
    var text = ""
    var height: CGFloat = 18
    var sending = false
    var error: String?
}

/// One subagent's transcript and composer, pushed over the Agents list. Stop, its model and working directory sit
/// in the header's ⋯ menu.
private struct SubagentDetail: View {
    let session: SessionSummary
    let subagent: SessionSubagent
    let back: () -> Void
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var feed: SubagentFeed
    @State private var draft = SubagentDraft()
    @Environment(\.pilotFonts) private var fonts

    init(session: SessionSummary, subagent: SessionSubagent, back: @escaping () -> Void) {
        self.session = session
        self.subagent = subagent
        self.back = back
        feed = AppModel.shared.subagentFeed(session.id, subagent.name)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let error = subagent.error {
                Text(error)
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.error)
                    .textSelection(.enabled)
                    .lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                HairlineDivider()
            }
            transcript
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

    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Button(action: back) { PilotSymbol(PilotIcon.back) }
                    .buttonStyle(QuietIconButtonStyle())
                    .help("All subagents")
                    .accessibilityLabel("Back to all subagents")
                Text(subagent.name)
                    .font(.pilot(.label, weight: .medium))
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                state
                Spacer(minLength: 8)
                actions
            }
            .padding(.leading, 6)
            .padding(.trailing, 8)
            .frame(minHeight: 32)
            HairlineDivider()
        }
    }

    @ViewBuilder
    private var state: some View {
        if subagent.isWorking {
            HStack(spacing: 0) {
                Text("Working · ")
                Text(Date(timeIntervalSince1970: subagent.createdAt / 1000), style: .relative)
            }
            .font(.pilot(.caption).monospacedDigit())
            .foregroundStyle(Theme.mutedForeground)
            .lineLimit(1)
            .accessibilityElement(children: .combine)
        } else if subagent.isFailed {
            Text("Failed").font(.pilot(.caption)).foregroundStyle(Theme.error)
        } else if subagent.retired == true {
            Text("Retired").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
        }
    }

    private var actions: some View {
        Menu {
            if subagent.isWorking {
                Button(role: .destructive) { model.stopSubagent(subagent.name, in: session.id) } label: {
                    Label("Stop", icon: PilotIcon.stop)
                }
                .disabled(model.pendingSessionActions.contains("\(session.id)/subagent/\(subagent.name)"))
                Divider()
            }
            if let modelName = subagent.model {
                Section("Model") {
                    Text(modelName)
                }
            }
            Section("Working directory") {
                Text(subagent.cwd.abbreviatingHome)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(subagent.cwd, forType: .string)
                } label: {
                    Label("Copy Path", icon: PilotIcon.copy)
                }
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: subagent.cwd)])
                } label: {
                    Label("Show in Finder", icon: PilotIcon.project)
                }
            }
        } label: {
            PilotSymbol(PilotIcon.more)
        }
        .menuStyle(.button)
        .buttonStyle(QuietIconButtonStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Subagent actions")
        .accessibilityLabel("Actions for \(subagent.name)")
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let error = feed.error {
                        Text(error).font(.pilot(.label)).foregroundStyle(Theme.error)
                    } else if feed.loading {
                        Text("Loading transcript…").font(.pilot(.label)).foregroundStyle(Theme.faintForeground)
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
        .frame(maxHeight: .infinity)
    }

    private var composer: some View {
        ComposerTray {
            VStack(alignment: .leading, spacing: 10) {
                ZStack(alignment: .topLeading) {
                    if draft.text.isEmpty {
                        Text(placeholder)
                            .font(fonts.body)
                            .foregroundStyle(Theme.faintForeground)
                            .allowsHitTesting(false)
                    }
                    ChatTextEditor(text: $draft.text, height: $draft.height, font: fonts.nsBody, maxLines: 8,
                                   focusOnAppear: false, isEditable: canMessage, completionDirectory: subagent.cwd) { flags in
                        send(subagent.isWorking && !flags.contains(.option) ? .steer : .followUp)
                    }
                    .frame(height: draft.height)
                    .accessibilityLabel("Message \(subagent.name)")
                }
                KeyHints(working: subagent.isWorking)
            }
        } controls: {
            Group {
                if let error = draft.error {
                    Text(error).foregroundStyle(Theme.error).lineLimit(2)
                } else {
                    Text("Messages go to \(subagent.name) only. Its answer comes back to this chat.")
                        .foregroundStyle(Theme.faintForeground)
                        .lineLimit(2)
                }
            }
            .font(.pilot(.caption))
            .padding(.leading, 4)
            Spacer(minLength: 8)
            Button { send(subagent.isWorking ? .steer : .followUp) } label: {
                PilotSymbol(PilotIcon.send, context: .toolbar)
            }
            .buttonStyle(CircleIconButtonStyle())
            .disabled(!canSend)
            .help(subagent.isWorking ? "Steer (↩)" : "Send (↩)")
            .accessibilityLabel(subagent.isWorking ? "Steer" : "Send")
        }
        .padding(10)
    }

    private var placeholder: String {
        if !subagent.acceptsMessages { return "This subagent is retired" }
        return subagent.isWorking ? "Steer \(subagent.name)…" : "Message \(subagent.name)…"
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
