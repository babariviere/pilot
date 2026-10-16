import PilotCore
import SwiftUI

/// One subagent's live, read-only transcript, streamed from pilotd. Shared by every view of that
/// subagent, so reopening its detail view never opens a second stream.
@MainActor
final class SubagentFeed: ObservableObject {
    @Published private(set) var presentation = TranscriptPresentation()
    @Published private(set) var configuration = SubagentConfiguration()
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
                configuration = SubagentConfiguration()
                loading = false
                error = nil
                return
            }
        }
        var configuration = self.configuration
        configuration.apply(events)
        if self.configuration != configuration { self.configuration = configuration }
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

/// Subagents at the top of the composer tray: "3 subagents · 1 working · 2 done", then one row per subagent with its
/// state, name and task, working ones first. The list opens when a subagent starts working; clicking a row opens its
/// transcript in the Agents tab.
struct SubagentsStrip: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded: Bool

    init(session: SessionSummary) {
        self.session = session
        _expanded = State(initialValue: (session.subagents ?? []).contains(where: \.isWorking))
    }

    var body: some View {
        let subagents = session.subagents ?? []
        let states = subagents.map { SubagentDisplayState($0, unread: model.isUnread($0, in: session.id)) }
        let ordered = zip(subagents, states).sorted { a, b in
            if a.1.trayOrder != b.1.trayOrder { return a.1.trayOrder < b.1.trayOrder }
            return a.0.createdAt > b.0.createdAt
        }
        let anyWorking = states.contains(.working)
        VStack(alignment: .leading, spacing: 2) {
            summary(states: states, working: anyWorking)
            if expanded {
                TrayRowList(count: ordered.count) {
                    ForEach(ordered, id: \.0.id) { subagent, state in
                        SubagentTrayRow(subagent: subagent, state: state) {
                            model.openSubagent(subagent.name, in: session.id)
                        }
                    }
                }
                .transition(Theme.Motion.insertion(reduceMotion: reduceMotion))
            }
        }
        .onChange(of: anyWorking) { _, working in
            if working, !expanded {
                withAnimation(Theme.Motion.standard(reduceMotion: reduceMotion)) { expanded = true }
            }
        }
    }

    private func summary(states: [SubagentDisplayState], working: Bool) -> some View {
        let title = states.count == 1 ? "1 subagent" : "\(states.count) subagents"
        let counts = SubagentTrayCounts(states)
        return Button(action: toggle) {
            HStack(spacing: 8) {
                Group {
                    if working {
                        EllipsisSpinner()
                    } else {
                        PilotSymbol(PilotIcon.subagents).foregroundStyle(Theme.faintForeground)
                    }
                }
                .frame(width: 14)
                Text(title)
                    .font(.pilot(.label, weight: .medium))
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
                    .fixedSize()
                if !counts.detail.isEmpty {
                    Text(counts.detail)
                        .font(.pilot(.label))
                        .monospacedDigit()
                        .foregroundStyle(Theme.faintForeground)
                        .lineLimit(1)
                }
                if counts.failed > 0 {
                    // Failure is the one subagent state that needs the user.
                    Text("· \(counts.failed) failed")
                        .font(.pilot(.label))
                        .foregroundStyle(Theme.destructive)
                        .lineLimit(1)
                        .fixedSize()
                }
                Spacer(minLength: 4)
                PilotSymbol(PilotIcon.disclosure, context: .disclosure)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .foregroundStyle(Theme.faintForeground)
                    .frame(width: 16, height: 16)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(expanded ? "Hide subagents" : "Show subagents")
        .accessibilityLabel(([title] + counts.parts).joined(separator: ", "))
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }

    private func toggle() {
        withAnimation(Theme.Motion.standard(reduceMotion: reduceMotion)) { expanded.toggle() }
    }
}

private extension SubagentDisplayState {
    /// Tray order: what is running, then what needs a look, then the rest.
    var trayOrder: Int {
        switch self {
        case .working: 0
        case .failed: 1
        case .newAnswer: 2
        case .idle: 3
        }
    }
}

/// The tray's per-state counts. An idle subagent has finished its latest task, so it counts as done.
private struct SubagentTrayCounts {
    var working = 0
    var done = 0
    var failed = 0

    init(_ states: [SubagentDisplayState]) {
        for state in states {
            switch state {
            case .working: working += 1
            case .failed: failed += 1
            case .newAnswer, .idle: done += 1
            }
        }
    }

    /// "· 2 working · 3 done"; failures are shown on their own, in red.
    var detail: String { [working > 0 ? "\(working) working" : nil, done > 0 ? "\(done) done" : nil]
        .compactMap { $0 }.map { "· " + $0 }.joined(separator: " ") }

    var parts: [String] {
        [working > 0 ? "\(working) working" : nil, done > 0 ? "\(done) done" : nil, failed > 0 ? "\(failed) failed" : nil]
            .compactMap { $0 }
    }
}

/// One subagent in the composer tray: state mark, name, task and a state word. Click to open its transcript.
private struct SubagentTrayRow: View {
    let subagent: SessionSubagent
    let state: SubagentDisplayState
    let open: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                mark.frame(width: 14)
                Text(subagent.name)
                    .font(.pilot(.label, weight: .medium))
                    .foregroundStyle(state == .idle ? Theme.mutedForeground : Theme.foreground)
                    .lineLimit(1)
                    .fixedSize()
                Text(subagent.task)
                    .font(.pilot(.label))
                    .foregroundStyle(Theme.faintForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                Text(label)
                    .font(.pilot(.caption))
                    .foregroundStyle(labelColor)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: QueuedMessagesStrip.rowHeight, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(hovered ? Theme.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .help(subagent.error.map { "\(subagent.name) failed: \($0)" } ?? subagent.task)
        .accessibilityLabel("\(subagent.name), \(label). \(subagent.task)")
        .accessibilityHint("Opens its transcript in the Agents tab")
    }

    private var label: String {
        switch state {
        case .working: "Working"
        case .failed: "Failed"
        case .newAnswer: "New answer"
        case .idle: "Done"
        }
    }

    private var labelColor: Color {
        switch state {
        case .working: Theme.workingInk
        case .failed: Theme.destructive
        case .newAnswer: Theme.info
        case .idle: Theme.faintForeground
        }
    }

    @ViewBuilder
    private var mark: some View {
        switch state {
        case .working: EllipsisSpinner()
        case .failed: PilotSymbol(PilotIcon.warning).foregroundStyle(Theme.destructive)
        case .newAnswer: Circle().fill(Theme.info).frame(width: 7, height: 7)
        case .idle: PilotSymbol(PilotIcon.complete).foregroundStyle(Theme.success)
        }
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

/// One subagent's transcript and composer, pushed over the Agents list. Its model and thinking stay visible;
/// Stop and the working directory sit in the header's ⋯ menu.
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
            configuration
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            HairlineDivider()
        }
    }

    private var configuration: some View {
        let model = feed.configuration.model ?? subagent.model
        let name = model?.split(separator: "/", maxSplits: 1).last.map(String.init) ?? "Model not reported"
        return HStack(spacing: 12) {
            Label(name, icon: PilotIcon.model)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(model ?? "Model not reported")
                .accessibilityLabel("Model: \(model ?? "not reported")")
            Label(feed.configuration.thinkingLabel, icon: PilotIcon.thinking)
                .fixedSize()
            Spacer(minLength: 0)
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
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
