import PilotCore
import SwiftUI

/// The Control screen: a read-only page about the control chat. Its memory summaries (a disclosure opens each line
/// into the two halves it was built from, down to the original message), the message log with search, what it
/// watches and the actions it took, and the health of its memory. Opened from the Control chat's header and ⌘K.
/// Agent and event text is quoted content: plain text beside a thin rule, never rendered as Markdown or acted on.
struct ControlScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var client
    @StateObject private var state: ControlScreenModel
    @StateObject private var details = ControlDetailsModel()
    @State private var observer: UUID?
    @FocusState private var searchFocused: Bool
    private let attachesDetails: Bool
    /// Lines opened once loaded, for snapshots.
    private let expanding: [ControlMemoryLine]

    /// `source` defaults to the local pilotd; snapshots pass a fixture and the section to show.
    init(source: ControlMemoryReading? = nil, section: ControlScreenSection = .summaries,
         expanding: [ControlMemoryLine] = []) {
        let state = ControlScreenModel(source: source ?? AppModel.shared.client)
        state.section = section
        _state = StateObject(wrappedValue: state)
        attachesDetails = source == nil
        self.expanding = expanding
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                picker.padding(.top, 16)
                content.padding(.top, 14)
            }
            .padding(.horizontal, 32)
            .padding(.vertical, 24)
            .frame(maxWidth: Theme.column, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .navigationTitle("Control")
        .navigationSubtitle(ControlChatIdentity.scope)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button { model.openControlChat() } label: { PilotSymbol(PilotIcon.back) }
                    .help("Back to the Control chat")
                    .accessibilityLabel("Back to the Control chat")
            }
        }
        .task {
            await state.load()
            for line in expanding { await state.toggle(line) }
        }
        .task(id: state.query) {
            // Debounced search. The first run belongs to load().
            guard state.logLoaded, state.searchQuery != state.logQuery else { return }
            try? await Task.sleep(for: ControlScreenModel.searchDelay)
            guard !Task.isCancelled else { return }
            await state.reloadLog()
        }
        .onAppear {
            if attachesDetails { details.attach(client) }
            observer = client.observeControlDetails { change in
                if change == .memory { state.scheduleRefresh() }
            }
        }
        .onDisappear {
            if let observer { client.stopObservingControlDetails(observer) }
            observer = nil
            state.stop()
            details.detach()
        }
        .onChange(of: client.connected) { _, connected in
            guard connected else { return }
            Task { await state.load() }
            details.reload()
        }
    }

    private var header: some View {
        PageHeader("Control", subtitle: "What the Control chat remembers and watches, and how its memory is doing. "
            + "Read-only: memory is never edited here.") {
            Button { model.openControlChat() } label: {
                Text("Open chat").font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                    .padding(.horizontal, 8).padding(.vertical, 4).contentShape(Rectangle())
            }
            .rowButtonStyle()
        }
    }

    private var picker: some View {
        Picker("Control section", selection: $state.section) {
            ForEach(ControlScreenSection.allCases, id: \.self) { section in
                Text(section.title).tag(section)
            }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .fixedSize()
        .help("Control sections")
    }

    @ViewBuilder private var content: some View {
        switch state.section {
        case .summaries: summaries
        case .log: logSection
        case .watches:
            LazyVStack(alignment: .leading, spacing: 0) {
                ControlDetailsList(details: details, client: client, context: hostContext, labelsWatches: true)
            }
        case .health: health
        }
    }

    // MARK: Summaries

    @ViewBuilder private var summaries: some View {
        if !state.viewLoaded {
            ProgressView("Loading memory…").frame(maxWidth: .infinity, alignment: .leading).padding(8)
        } else if let error = state.viewError, state.lines.isEmpty {
            InlineProblem(error) { Task { await state.loadView() } }.padding(8)
        } else if state.lines.isEmpty {
            EmptyStateView(icon: PilotIcon.memory, title: "No memory yet",
                           message: "Messages to and from the Control chat are logged and summarized here as it works.")
        } else {
            Text(summaryStatus)
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 8).padding(.bottom, 6)
            if let error = state.viewError {
                InlineProblem(error) { Task { await state.loadView() } }.padding(.horizontal, 8).padding(.bottom, 6)
            }
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(state.treeRows) { row in
                    treeRow(row)
                }
            }
            .keyboardList()
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Memory summaries")
        }
    }

    private var summaryStatus: String {
        let count = state.lines.count
        let pending = state.pendingLines
        let lines = "\(count) \(count == 1 ? "line" : "lines") in the current view, oldest first"
        return pending == 0 ? lines : "\(lines) · \(pending) not summarized yet"
    }

    @ViewBuilder private func treeRow(_ row: ControlMemoryTreeRow) -> some View {
        let indent = CGFloat(row.depth) * 18
        switch row.kind {
        case let .line(line, expanded):
            ControlMemoryLineRow(line: line, expanded: expanded) { Task { await state.toggle(line) } }
                .padding(.leading, indent)
                .keyboardListItem(row.id) { Task { await state.toggle(line) } }
        case let .message(message):
            ControlMemoryMessageView(message: message, loading: state.loadingMessages.contains(message.message.id)) {
                Task { await state.loadMore(message: message.message.id) }
            }
            .padding(.leading, indent + 22)
            .padding(.vertical, 6)
            .keyboardListItem(row.id) {}
        case .loading:
            ProgressView().controlSize(.small)
                .padding(.leading, indent + 22).padding(.vertical, 6)
        case let .failed(error):
            InlineProblem(error) { if let line = row.parent { Task { await state.retry(line) } } }
                .padding(.leading, indent + 22).padding(.vertical, 6)
        }
    }

    // MARK: Log

    @ViewBuilder private var logSection: some View {
        searchField.padding(.bottom, 10)
        if !state.logLoaded {
            ProgressView("Loading the log…").frame(maxWidth: .infinity, alignment: .leading).padding(8)
        } else if let error = state.logError, state.log.isEmpty {
            InlineProblem(error) { Task { await state.reloadLog() } }.padding(8)
        } else {
            if let error = state.logError {
                InlineProblem(error) { Task { await state.reloadLog() } }.padding(.horizontal, 8).padding(.bottom, 6)
            }
            if state.log.isEmpty {
                Text(emptyLog).font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                    .padding(.horizontal, 8).padding(.vertical, 6)
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(state.log.enumerated()), id: \.element.id) { index, entry in
                        if index > 0 { HairlineDivider() }
                        ControlLogRow(entry: entry, open: state.openLogRows.contains(entry.id),
                                      message: state.messages[entry.id],
                                      failure: state.failures["\(entry.id)+1"],
                                      loading: state.loadingMessages.contains(entry.id),
                                      toggle: { Task { await state.toggleLogRow(entry.id) } },
                                      loadMore: { Task { await state.loadMore(message: entry.id) } })
                            .keyboardListItem("log:\(entry.id)") { Task { await state.toggleLogRow(entry.id) } }
                    }
                }
                .keyboardList()
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Message log")
            }
            if state.logNext != nil, state.log.count < ControlMemoryLog.cap {
                quietButton(state.searchQuery != nil && state.log.isEmpty ? "Search older messages" : "Show more") {
                    Task { await state.loadOlderLog() }
                }
                .disabled(state.loadingOlder)
                .padding(.top, 4)
            }
        }
    }

    private var emptyLog: String {
        guard state.logQuery != nil else { return "No messages logged yet." }
        return state.logNext == nil ? "No matching messages." : "No matches in the most recent messages."
    }

    private var searchField: some View {
        HStack(spacing: 7) {
            PilotSymbol(PilotIcon.search).foregroundStyle(Theme.faintForeground)
            TextField("Search the log", text: $state.query)
                .textFieldStyle(.plain)
                .font(.pilot(.body))
                .focused($searchFocused)
                .focusEffectDisabled()
                .onExitCommand { state.query = "" }
                .accessibilityLabel("Search the Control chat's log")
            if !state.query.isEmpty {
                Button { state.query = "" } label: {
                    PilotSymbol(PilotIcon.clearField, context: .toolbar).foregroundStyle(Theme.faintForeground)
                }
                .buttonStyle(.plain)
                .help("Clear search (Esc)")
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border))
    }

    // MARK: Health

    @ViewBuilder private var health: some View {
        if let stats = state.stats {
            VStack(spacing: 0) {
                SettingsRow("Messages logged") { value("\(stats.count)") }
                SettingsRow("Oldest message") { value(stats.oldestAt.map(RelativeDate.exact) ?? "None") }
                SettingsRow("Newest message") { value(stats.newestAt.map(RelativeDate.exact) ?? "None") }
                SettingsRow("Summaries waiting", detail: "Queued or being written.") { value("\(stats.pendingJobs)") }
                SettingsRow("Failed summaries", detail: stats.failedJobs > 0 ? "They retry with the next message." : nil) {
                    Text("\(stats.failedJobs)").font(.pilot(.body)).monospacedDigit()
                        .foregroundStyle(stats.failedJobs > 0 ? Theme.error : Theme.foreground)
                }
                SettingsRow("View size", detail: stats.merging ? "Merging older lines to make room." : nil) {
                    value(ControlMemoryFormat.bytes(stats.viewBytes))
                }
                SettingsRow("Database size", detail: "The log, summaries and audit, with the write-ahead log.") {
                    value(ControlMemoryFormat.bytes(stats.dbBytes))
                }
                HairlineDivider()
            }
            if let error = state.statsError {
                InlineProblem(error) { Task { await state.loadStats() } }.padding(.top, 8)
            }
        } else if let error = state.statsError {
            InlineProblem(error) { Task { await state.loadStats() } }.padding(8)
        } else {
            ProgressView().controlSize(.small).padding(8)
        }
    }

    private func value(_ text: String) -> some View {
        Text(text).font(.pilot(.body)).foregroundStyle(Theme.foreground).monospacedDigit().textSelection(.enabled)
    }

    private func quietButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 8).padding(.vertical, 6).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// One line of the view: a disclosure, the messages it covers and its summary (quoted), or a plain note that it is
/// not summarized yet.
struct ControlMemoryLineRow: View {
    let line: ControlMemoryLine
    let expanded: Bool
    let toggle: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Button(action: toggle) {
                DisclosureChevron(expanded: expanded).frame(width: 16, height: 18).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "Collapse \(ControlMemoryFormat.range(line))" : "Expand \(ControlMemoryFormat.range(line))")
            VStack(alignment: .leading, spacing: 3) {
                Text(ControlMemoryFormat.range(line))
                    .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                if line.isPending {
                    Text("Not summarized yet. Expand to read the original.")
                        .font(.pilot(.body)).italic().foregroundStyle(Theme.mutedForeground)
                } else {
                    QuoteBlock {
                        Text(line.text).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                            .lineLimit(expanded ? nil : 3).textSelection(.enabled)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
        .padding(.trailing, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture(perform: toggle)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// A whole logged message: who or what it came from and when, then its text quoted. Tool calls show their name and
/// input. Long messages load in pages with "Show more".
struct ControlMemoryMessageView: View {
    let message: ControlMemoryMessageText
    var loading = false
    let loadMore: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(ControlMemoryFormat.kind(message.message.kind)) · \(RelativeDate.exact(message.message.at))")
                .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
            QuoteBlock {
                if let tool = ControlMemoryFormat.toolParts(message) {
                    if let name = tool.name {
                        Text(name).font(.pilot(.caption, weight: .medium, design: .monospaced)).foregroundStyle(Theme.foreground)
                    }
                    if let input = tool.input {
                        Text(input).font(.pilot(.caption, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                            .textSelection(.enabled)
                    }
                    if !tool.text.isEmpty { messageText(tool.text) }
                } else {
                    messageText(message.text, monospaced: message.format == "json")
                }
            }
            if message.canLoadMore {
                Button(loading ? "Loading…" : "Show more", action: loadMore)
                    .buttonStyle(.plain)
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .disabled(loading)
            } else if message.truncated {
                Text("Showing the first part of a very long message.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func messageText(_ text: String, monospaced: Bool = false) -> some View {
        Text(text)
            .font(monospaced ? .pilot(.caption, design: .monospaced) : .pilot(.body))
            .foregroundStyle(Theme.foreground)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One log row: kind, date and number, then the text quoted (clipped), with a tool call's name and input. Opening it
/// loads the whole message below.
struct ControlLogRow: View {
    let entry: ControlMemoryLogEntry
    let open: Bool
    let message: ControlMemoryMessageText?
    let failure: String?
    let loading: Bool
    let toggle: () -> Void
    let loadMore: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                DisclosureChevron(expanded: open).frame(width: 16)
                Text(ControlMemoryFormat.kind(entry.kind)).font(.pilot(.label, weight: .medium)).foregroundStyle(Theme.foreground)
                Text("#\(entry.id) · \(RelativeDate.ago(entry.at))").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                    .help(RelativeDate.exact(entry.at))
                Spacer(minLength: 0)
            }
            Group {
                if open {
                    if let message {
                        ControlMemoryMessageView(message: message, loading: loading, loadMore: loadMore)
                    } else if let failure {
                        InlineProblem(failure, retry: toggle)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                } else {
                    preview
                }
            }
            .padding(.leading, 22)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture(perform: toggle)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(open ? "Closes the message" : "Shows the whole message")
    }

    @ViewBuilder private var preview: some View {
        let text = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if entry.kind == .tool || !text.isEmpty {
            let content = VStack(alignment: .leading, spacing: 3) {
                if let name = entry.name {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(name).font(.pilot(.caption, weight: .medium, design: .monospaced)).foregroundStyle(Theme.foreground)
                        if let input = entry.input {
                            Text(input).font(.pilot(.caption, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                                .lineLimit(2)
                        }
                    }
                }
                if !text.isEmpty {
                    Text(text).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(4)
                }
            }
            if ControlMemoryFormat.isQuoted(entry.kind) { QuoteBlock { content } } else { content }
        }
    }
}
