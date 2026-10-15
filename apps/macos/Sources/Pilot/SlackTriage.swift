import AppKit
import PilotCore
import SwiftUI

// Slack triage: a project's classified Slack messages as a table or a board by status, with an inspector to
// reclassify one and start work from it. Type, label, severity and status are local overrides kept by pilotd:
// the classifier never overwrites them, and nothing is written to Slack. Opened from the project page's
// Tracked section and … menu, and from the Inbox, through AppModel.openSlackTriage.

extension SlackMessageType {
    /// Picker and keyboard (T) order.
    static let ordered: [SlackMessageType] = [.bug, .question, .request, .unknown]

    var title: String {
        switch self {
        case .bug: "Bug"
        case .question: "Question"
        case .request: "Request"
        case .unknown: "Unknown"
        }
    }

    var icon: PilotIcon {
        switch self {
        case .bug: PilotIcon.bug
        case .question: PilotIcon.question
        case .request: PilotIcon.claim
        case .unknown: PilotIcon.message
        }
    }
}

extension SlackSeverity {
    /// Most urgent first, the default sort.
    static let ordered: [SlackSeverity] = [.critical, .high, .medium, .low]

    var title: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .critical: "Critical"
        }
    }

    var rank: Int { Self.ordered.firstIndex(of: self) ?? Self.ordered.count }
}

extension SlackLocalStatus {
    static let ordered: [SlackLocalStatus] = [.open, .inProgress, .done, .dismissed]

    var title: String {
        switch self {
        case .open: "Open"
        case .inProgress: "In progress"
        case .done: "Done"
        case .dismissed: "Dismissed"
        }
    }
}

enum SlackTriageLayout: String, CaseIterable {
    case table, board
    var title: String { self == .table ? "Table" : "Board" }
}

// MARK: Text

/// Filtering, sorting, keyboard moves and wording of the triage view, kept apart from views for tests.
enum SlackTriageText {
    enum LabelFilter: Hashable {
        case all, none, named(String)
    }

    struct Filter: Equatable {
        var type: SlackMessageType?
        var label: LabelFilter = .all
        /// A configured channel ID.
        var channel: String?
        var query = ""
        /// Messages whose label is marked "Hide from Inbox".
        var showHidden = false

        var isNarrowed: Bool { type != nil || label != .all || channel != nil || !trimmedQuery.isEmpty }
        var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    /// Effective values. Items without triage values fall back to their stored metadata.
    static func triage(_ item: TrackedItem) -> SlackTriage {
        if let slack = item.slack { return slack }
        let metadata = item.metadata
        return SlackTriage(type: metadata["type"]?.string.flatMap(SlackMessageType.init(rawValue:)) ?? .unknown,
                           label: metadata["label"]?.string,
                           severity: metadata["severity"]?.string.flatMap(SlackSeverity.init(rawValue:)) ?? .low,
                           status: item.dismissed ? .dismissed : .open)
    }

    static func channelId(_ item: TrackedItem) -> String? { item.metadata["channel"]?.string }

    static func replies(_ item: TrackedItem) -> Int? {
        guard case let .number(value) = item.metadata["replies"] else { return nil }
        return Int(value)
    }

    static func hiddenLabels(_ labels: [SlackProjectLabel]) -> Set<String> {
        Set(labels.filter { $0.hideFromInbox == true }.map(\.name))
    }

    /// What the view lists: filters applied, then severity (most urgent first), then newest first.
    static func visible(_ items: [TrackedItem], filter: Filter, hidden: Set<String>, showDismissed: Bool)
        -> [TrackedItem] {
        let query = filter.trimmedQuery
        return items.filter { item in
            let triage = triage(item)
            if triage.status == .dismissed, !showDismissed { return false }
            if !filter.showHidden, triage.label.map(hidden.contains) == true { return false }
            if let type = filter.type, triage.type != type { return false }
            switch filter.label {
            case .all: break
            case .none: if triage.label != nil { return false }
            case let .named(name): if triage.label != name { return false }
            }
            if let channel = filter.channel, channelId(item) != channel { return false }
            if !query.isEmpty, !item.title.localizedCaseInsensitiveContains(query),
               !TrackedItemText.identifier(item).localizedCaseInsensitiveContains(query) { return false }
            return true
        }
        .sorted(by: precedes)
    }

    static func precedes(_ lhs: TrackedItem, _ rhs: TrackedItem) -> Bool {
        let left = triage(lhs).severity.rank, right = triage(rhs).severity.rank
        if left != right { return left < right }
        if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
        return lhs.id < rhs.id
    }

    /// Messages with a hidden label, for "Show hidden (N)".
    static func hiddenCount(_ items: [TrackedItem], hidden: Set<String>, showDismissed: Bool) -> Int {
        guard !hidden.isEmpty else { return 0 }
        return items.filter { item in
            let triage = triage(item)
            return (showDismissed || triage.status != .dismissed) && triage.label.map(hidden.contains) == true
        }.count
    }

    static func boardColumns(showDismissed: Bool) -> [SlackLocalStatus] {
        showDismissed ? SlackLocalStatus.ordered : [.open, .inProgress, .done]
    }

    /// Board columns of already sorted items.
    static func board(_ items: [TrackedItem], showDismissed: Bool) -> [SlackBoardColumn] {
        boardColumns(showDismissed: showDismissed).map { status in
            SlackBoardColumn(status: status, items: items.filter { triage($0).status == status })
        }
    }

    /// Item ids in keyboard order: one column for the table, one per status for the board.
    static func keyColumns(_ items: [TrackedItem], layout: SlackTriageLayout, showDismissed: Bool) -> [[String]] {
        layout == .table ? [items.map(\.id)] : board(items, showDismissed: showDismissed).map { $0.items.map(\.id) }
    }

    /// Arrow-key moves: up and down within a column, left and right to the nearest row of the next non-empty
    /// column. The table is a single column. With nothing selected, any move selects the first item.
    static func move(from selection: String?, in columns: [[String]], dx: Int = 0, dy: Int = 0) -> String? {
        guard let selection, let column = columns.firstIndex(where: { $0.contains(selection) }),
              let row = columns[column].firstIndex(of: selection)
        else { return columns.first { !$0.isEmpty }?.first }
        if dx != 0 {
            var target = column + dx
            while columns.indices.contains(target), columns[target].isEmpty { target += dx }
            guard columns.indices.contains(target) else { return selection }
            return columns[target][min(row, columns[target].count - 1)]
        }
        return columns[column][min(max(row + dy, 0), columns[column].count - 1)]
    }

    /// The item to select once the selected one leaves the list: the next one in its column, else the previous.
    static func successor(of selection: String, in columns: [[String]]) -> String? {
        guard let column = columns.first(where: { $0.contains(selection) }),
              let row = column.firstIndex(of: selection) else { return nil }
        if row + 1 < column.count { return column[row + 1] }
        return row > 0 ? column[row - 1] : nil
    }

    /// T: the next type, wrapping around.
    static func nextType(_ type: SlackMessageType) -> SlackMessageType {
        let types = SlackMessageType.ordered
        return types[((types.firstIndex(of: type) ?? -1) + 1) % types.count]
    }

    /// L: each project label in order, then no label, then the first again. nil when there are no labels.
    static func nextLabel(_ label: String?, names: [String]) -> SlackOverrides? {
        guard !names.isEmpty else { return nil }
        guard let label, let index = names.firstIndex(of: label) else { return SlackOverrides(label: names[0]) }
        return index + 1 < names.count ? SlackOverrides(label: names[index + 1]) : SlackOverrides(clearLabel: true)
    }

    /// The local result of a change, shown until pilotd confirms it.
    static func applying(_ change: SlackOverrides, to triage: SlackTriage) -> SlackTriage {
        var overrides = triage.overrides
        var label = triage.label
        if let type = change.type { overrides.type = type }
        if change.clearLabel {
            overrides.label = nil
            overrides.clearLabel = true
            label = nil
        } else if let value = change.label {
            overrides.label = value
            overrides.clearLabel = false
            label = value
        }
        if let severity = change.severity { overrides.severity = severity }
        if let status = change.status { overrides.status = status }
        return SlackTriage(type: change.type ?? triage.type, label: label, severity: change.severity ?? triage.severity,
                           status: change.status ?? triage.status, overrides: overrides)
    }

    /// "#bugs · 2h ago · 7 replies".
    static func meta(_ item: TrackedItem, now: Date) -> String {
        var parts = [TrackedItemText.identifier(item), ProjectPageText.compactAgo(item.updatedAt, now: now)]
        if let replies = replies(item), replies > 0 { parts.append(replies == 1 ? "1 reply" : "\(replies) replies") }
        return parts.joined(separator: " · ")
    }

    /// "You changed the type and label." once the user overrode the classifier.
    static func overridden(_ overrides: SlackOverrides) -> String? {
        var fields: [String] = []
        if overrides.type != nil { fields.append("type") }
        if overrides.label != nil || overrides.clearLabel { fields.append("label") }
        if overrides.severity != nil { fields.append("severity") }
        guard let last = fields.last else { return nil }
        let list = fields.count == 1 ? last : fields.dropLast().joined(separator: ", ") + " and " + last
        return "You changed the \(list). Pilot keeps your choice and learns from it."
    }

    /// "Bug · No label" for a correction in Linear and Slack settings.
    static func correction(_ values: SlackOverrides) -> String {
        var parts: [String] = []
        if let type = values.type { parts.append(type.title) }
        if values.clearLabel { parts.append("No label") } else if let label = values.label { parts.append(label) }
        if let severity = values.severity { parts.append("\(severity.title) severity") }
        if let status = values.status { parts.append(status.title) }
        return parts.joined(separator: " · ")
    }

    /// "23 messages" or "4 of 23 messages".
    static func count(shown: Int, of total: Int) -> String {
        let noun = total == 1 ? "message" : "messages"
        return shown == total ? "\(total) \(noun)" : "\(shown) of \(total) \(noun)"
    }

    static func typeFilterTitle(_ type: SlackMessageType?) -> String { "Type: \(type?.title ?? "All")" }

    static func labelFilterTitle(_ label: LabelFilter) -> String {
        switch label {
        case .all: "Label: All"
        case .none: "Label: None"
        case let .named(name): "Label: \(name)"
        }
    }

    static func accessibilityLabel(_ item: TrackedItem, now: Date) -> String {
        let triage = triage(item)
        var parts = [item.title, triage.type.title, "\(triage.severity.title) severity"]
        if let label = triage.label { parts.append("label \(label)") }
        parts.append(triage.status.title)
        parts.append(meta(item, now: now))
        return parts.joined(separator: ", ")
    }
}

struct SlackBoardColumn {
    let status: SlackLocalStatus
    let items: [TrackedItem]
}

extension TrackedItem {
    /// The same item with new triage values, for local changes before pilotd confirms them.
    func withTriage(_ slack: SlackTriage) -> TrackedItem {
        TrackedItem(id: id, projectId: projectId, kind: kind, externalId: externalId, title: title, url: url,
                    status: status, metadata: metadata, dismissed: slack.status == .dismissed, sessionId: sessionId,
                    missionId: missionId, sessionIds: sessionIds, missionIds: missionIds, slack: slack,
                    createdAt: createdAt, updatedAt: updatedAt)
    }
}

// MARK: Model

/// A project's Slack messages: a bounded number of pages, refreshed on WebSocket invalidation (coalesced),
/// with local changes shown at once and kept until pilotd confirms them.
@MainActor
final class SlackTriageModel: ObservableObject {
    let projectId: String
    @Published private(set) var items: [TrackedItem] = []
    /// Active (not dismissed) messages in pilotd, which can exceed the loaded rows.
    @Published private(set) var total = 0
    @Published private(set) var loaded = false
    @Published private(set) var error: String?
    /// Per-item failures of a change, shown in the inspector.
    @Published private(set) var errors: [String: String] = [:]
    @Published var showDismissed = false { didSet { if showDismissed != oldValue { reload() } } }
    private var pending: [String: SlackTriage] = [:]
    private weak var client: PilotClient?
    private var observer: UUID?
    private var loading: Task<Void, Never>?

    static let pageSize = 100
    /// Bounds memory and layout; the view says when more exist.
    static let maxItems = 500

    init(projectId: String) { self.projectId = projectId }

    func start(client: PilotClient) {
        self.client = client
        if observer == nil {
            observer = client.observeTrackedItems { [weak self] projectId in
                guard let self, projectId == self.projectId else { return }
                self.reload(after: .milliseconds(300))
            }
        }
        reload()
    }

    func stop() {
        if let observer { client?.stopObservingTrackedItems(observer) }
        observer = nil
        loading?.cancel()
    }

    /// Latest wins. Shown rows stay until the new pages arrive.
    func reload(after delay: Duration = .zero) {
        loading?.cancel()
        loading = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled, let self, let client = self.client else { return }
            let showDismissed = self.showDismissed
            do {
                var active: [TrackedItem] = []
                var total = 0
                repeat {
                    let page = try await client.trackedItems(projectId: self.projectId, kind: .slack,
                                                             limit: Self.pageSize, offset: active.count)
                    total = page.total
                    active += page.items
                    if page.items.isEmpty { break }
                } while active.count < min(total, Self.maxItems) && !Task.isCancelled
                var next = active
                if showDismissed {
                    next += try await client.trackedItems(projectId: self.projectId, kind: .slack, dismissed: true,
                                                          limit: Self.pageSize).items
                }
                guard !Task.isCancelled, showDismissed == self.showDismissed else { return }
                next = next.map { item in self.pending[item.id].map(item.withTriage) ?? item }
                if self.items != next { self.items = next }
                if self.total != total { self.total = total }
                self.error = nil
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
            self.loaded = true
        }
    }

    /// Shows a change at once, then saves it as an override. A failure restores pilotd's values.
    func update(_ item: TrackedItem, _ change: SlackOverrides) {
        guard let client, let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        let next = SlackTriageText.applying(change, to: SlackTriageText.triage(items[index]))
        pending[item.id] = next
        items[index] = items[index].withTriage(next)
        errors[item.id] = nil
        Task {
            do {
                let saved = try await client.updateTrackedItem(item.id, TrackedItemPatch(slack: change))
                guard pending[item.id] == next else { return }
                pending[item.id] = nil
                if let index = items.firstIndex(where: { $0.id == saved.id }), items[index] != saved { items[index] = saved }
            } catch {
                guard pending[item.id] == next else { return }
                pending[item.id] = nil
                errors[item.id] = "Couldn't save the change: \(error.localizedDescription)"
                reload()
            }
        }
    }

    /// Snapshots only: rows without a daemon.
    func loadFixture(_ items: [TrackedItem]) {
        self.items = items
        total = items.filter { !$0.dismissed }.count
        loaded = true
    }
}

/// The inspector's quote of a Slack message.
enum SlackExcerptState: Equatable {
    case loading
    case loaded(SlackExcerpt)
    /// A plain reason. Selecting the message again, or Try Again, reads it once more.
    case unavailable(String)
}

/// Slack messages behind the selected triage items, read from pilotd on demand. Held in memory for this page only
/// and bounded to the latest reads; nothing is written to disk. pilotd reads one message at a time, latest wins.
@MainActor
final class SlackExcerptStore: ObservableObject {
    @Published private(set) var states: [String: SlackExcerptState] = [:]
    private var recent: [String] = []

    static let limit = 40
    /// Moving through the list with the arrow keys reads only the message the selection settles on.
    static let settle: Duration = .milliseconds(150)

    func state(_ id: String) -> SlackExcerptState { states[id] ?? .loading }

    /// Reads a message unless it is already shown. Call from a task tied to the selection, so a new selection
    /// cancels the previous read.
    func load(_ id: String, settle: Duration = SlackExcerptStore.settle,
              read: (String) async throws -> SlackExcerpt) async {
        if case .loaded = states[id] { return }
        if states[id] != nil { states[id] = nil }
        if settle > .zero { try? await Task.sleep(for: settle) }
        guard !Task.isCancelled else { return }
        do {
            remember(id, .loaded(try await read(id)))
        } catch {
            guard !Task.isCancelled else { return }
            remember(id, .unavailable(Self.reason(error)))
        }
    }

    /// Snapshots only.
    func loadFixture(_ states: [String: SlackExcerptState]) {
        self.states = states
        recent = Array(states.keys)
    }

    private func remember(_ id: String, _ state: SlackExcerptState) {
        states[id] = state
        recent.removeAll { $0 == id }
        recent.append(id)
        while recent.count > Self.limit { states[recent.removeFirst()] = nil }
    }

    /// pilotd's own plain reason (sign-in, Slack unreachable, channel no longer tracked), or a generic one.
    static func reason(_ error: Error) -> String {
        guard let error = error as? ClientError, error.status == 409 || error.status == 503,
              !error.message.isEmpty, !error.message.hasPrefix("Superseded")
        else { return "Couldn't load this message." }
        return error.message.hasSuffix(".") ? error.message : error.message + "."
    }
}

// MARK: Page

/// The triage view in the main window, shown in place of the project page.
struct SlackTriagePage: View {
    let projectId: String
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @Environment(\.openSettings) private var openSettings
    @StateObject private var triage: SlackTriageModel
    @StateObject private var actions = TrackedItemActions()
    @StateObject private var excerpts: SlackExcerptStore
    @AppStorage("pilot.slackTriageLayout") private var layout: SlackTriageLayout = .table
    @State private var filter = SlackTriageText.Filter()
    @State private var selection: String?
    /// Bumped by the inspector's Try Again, to read the selected message once more.
    @State private var excerptAttempt = 0
    @FocusState private var listFocused: Bool
    private let fixture: Bool

    init(projectId: String, fixture: [TrackedItem]? = nil, layout: SlackTriageLayout? = nil,
         selection: String? = nil, filter: SlackTriageText.Filter = .init(),
         excerpts: [String: SlackExcerptState] = [:]) {
        self.projectId = projectId
        self.fixture = fixture != nil
        let model = SlackTriageModel(projectId: projectId)
        if let fixture { model.loadFixture(fixture) }
        _triage = StateObject(wrappedValue: model)
        let store = SlackExcerptStore()
        store.loadFixture(excerpts)
        _excerpts = StateObject(wrappedValue: store)
        if let layout { _layout = AppStorage(wrappedValue: layout, "pilot.slackTriageLayout.snapshot") }
        _selection = State(initialValue: selection)
        _filter = State(initialValue: filter)
    }

    var body: some View {
        Group {
            if let project = client.project(projectId) {
                content(project)
                    .navigationTitle("Slack triage")
                    .navigationSubtitle(project.name)
                    .toolbar { toolbar(project) }
                    .searchable(text: $filter.query, placement: .toolbar, prompt: "Search messages")
            } else {
                EmptyStateView(icon: PilotIcon.project, title: "This project no longer exists",
                               message: "It was removed from Pilot. Its folder is unchanged.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .onAppear { if !fixture { triage.start(client: client) } }
        .onDisappear { triage.stop() }
    }

    @ToolbarContentBuilder
    private func toolbar(_ project: Project) -> some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button { model.openProject(project.id) } label: { PilotSymbol(PilotIcon.back) }
                .help("Back to \(project.name)")
                .accessibilityLabel("Back to \(project.name)")
        }
        ToolbarItem(placement: .principal) {
            SlackTriageLayoutPicker(layout: $layout)
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                if let source = client.source(projectId: project.id, kind: .slack) {
                    Button { actions.sync(source, client: client) } label: {
                        Label("Sync Now", icon: PilotIcon.refresh)
                    }
                }
                Button { openTrackingSettings(project) } label: { Label("Linear and Slack Settings…", icon: PilotIcon.settings) }
            } label: {
                PilotSymbol(PilotIcon.more, context: .toolbar)
            }
            .menuIndicator(.hidden)
            .help("Slack triage actions")
            .accessibilityLabel("Slack triage actions")
        }
    }

    @ViewBuilder private func content(_ project: Project) -> some View {
        if (project.tracking?.slackChannels ?? []).isEmpty, triage.items.isEmpty {
            EmptyStateView(icon: PilotIcon.chats, title: "No Slack channels yet",
                           message: "Add channels in Linear and Slack settings. Pilot reads new messages, sorts them by type and severity, and lists them here.") {
                Button("Linear and Slack Settings…") { openTrackingSettings(project) }.buttonStyle(.borderedProminent)
            }
            .frame(maxHeight: .infinity)
        } else if !triage.loaded {
            ProgressView("Loading messages…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                loaded(project, now: context.date)
            }
        }
    }

    private func loaded(_ project: Project, now: Date) -> some View {
        let labels = project.tracking?.slackLabels ?? []
        let hidden = SlackTriageText.hiddenLabels(labels)
        let visible = SlackTriageText.visible(triage.items, filter: filter, hidden: hidden,
                                              showDismissed: triage.showDismissed)
        let unfiltered = SlackTriageText.visible(triage.items, filter: .init(showHidden: filter.showHidden),
                                                 hidden: hidden, showDismissed: triage.showDismissed).count
        let columns = SlackTriageText.keyColumns(visible, layout: layout, showDismissed: triage.showDismissed)
        let selected = selection.flatMap { id in triage.items.first { $0.id == id } }
        return VStack(spacing: 0) {
            SlackTriageFilterBar(project: project, filter: $filter, showDismissed: $triage.showDismissed,
                                 hiddenCount: SlackTriageText.hiddenCount(triage.items, hidden: hidden,
                                                                          showDismissed: triage.showDismissed),
                                 shown: visible.count, total: unfiltered)
            HairlineDivider()
            if let source = client.source(projectId: project.id, kind: .slack),
               TrackedItemText.sourceLine(source, now: now).tone != .quiet || actions.syncing.contains(source.id) {
                TrackedSourceStatusLine(source: source, actions: actions, now: now)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                HairlineDivider()
            }
            if let error = triage.error {
                ProjectRefreshBanner(receivedAt: nil, error: error, retrying: false) { triage.reload() }
                    .padding(.horizontal, 16).padding(.vertical, 6)
            }
            HStack(spacing: 0) {
                list(visible: visible, hidden: hidden, columns: columns, now: now)
                    .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                    .focusable()
                    .focused($listFocused)
                    .focusEffectDisabled()
                    .onKeyPress(keys: [.upArrow, .downArrow, .leftArrow, .rightArrow, .return]) { press in
                        key(press, columns: columns, labels: labels)
                    }
                    .onKeyPress(characters: CharacterSet(charactersIn: "tTlLdD")) { press in
                        key(press, columns: columns, labels: labels)
                    }
                Rectangle().fill(Theme.border).frame(width: 1)
                SlackTriageInspector(item: selected, labels: labels, now: now, actions: actions,
                                     error: selected.flatMap { triage.errors[$0.id] },
                                     excerpt: selected.map { excerpts.state($0.id) } ?? .loading,
                                     retryExcerpt: { excerptAttempt += 1 }) { change in
                    if let selected { update(selected, change, columns: columns) }
                }
                .frame(width: 300)
                .task(id: "\(selected?.id ?? "")#\(excerptAttempt)") {
                    guard !fixture, let id = selected?.id else { return }
                    await excerpts.load(id) { try await client.slackExcerpt($0) }
                }
            }
        }
        .onAppear {
            if selection == nil { selection = columns.first { !$0.isEmpty }?.first }
            if !fixture { listFocused = true }
        }
    }

    @ViewBuilder
    private func list(visible: [TrackedItem], hidden: Set<String>, columns: [[String]], now: Date) -> some View {
        if visible.isEmpty {
            Group {
                if filter.isNarrowed {
                    EmptyStateView(icon: PilotIcon.filter, title: "No messages match",
                                   message: "Try another filter or search.") {
                        Button("Clear Filters") { filter = SlackTriageText.Filter(showHidden: filter.showHidden) }
                    }
                } else {
                    EmptyStateView(icon: PilotIcon.inbox, title: "Nothing to triage",
                                   message: "New messages from your Slack channels appear here after the next sync.")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let rows = SlackTriageRowActions(
                start: { actions.startChat($0, app: model) },
                mission: { actions.startMission($0, app: model) },
                open: { item in if let url = trackedBrowserURL(item.url) { BrowserLinkOpener.shared.open(url) } },
                toggleDismissed: { toggleDismissed($0, columns: columns) },
                select: { item in
                    selection = item.id
                    listFocused = true
                },
                chatStatus: { item in (item.sessionIds?.last ?? item.sessionId).flatMap { client.session($0)?.status } })
            VStack(spacing: 0) {
                switch layout {
                case .table:
                    SlackTriageTable(items: visible, hidden: hidden, selection: selection, now: now, actions: rows)
                case .board:
                    SlackTriageBoard(columns: SlackTriageText.board(visible, showDismissed: triage.showDismissed),
                                     hidden: hidden, selection: selection, now: now, actions: rows)
                }
                if triage.total > SlackTriageModel.maxItems {
                    Text("Showing the latest \(SlackTriageModel.maxItems) of \(triage.total) messages.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16).padding(.vertical, 6)
                }
            }
        }
    }

    private func key(_ press: KeyPress, columns: [[String]], labels: [SlackProjectLabel]) -> KeyPress.Result {
        guard press.modifiers.isDisjoint(with: [.command, .control, .option]) else { return .ignored }
        let selected = selection.flatMap { id in triage.items.first { $0.id == id } }
        switch press.key {
        case .upArrow: selection = SlackTriageText.move(from: selection, in: columns, dy: -1)
        case .downArrow: selection = SlackTriageText.move(from: selection, in: columns, dy: 1)
        case .leftArrow: selection = SlackTriageText.move(from: selection, in: columns, dx: -1)
        case .rightArrow: selection = SlackTriageText.move(from: selection, in: columns, dx: 1)
        case .return:
            guard let selected else { return .ignored }
            actions.startChat(selected, app: model)
        default:
            guard let selected else { return .ignored }
            let current = SlackTriageText.triage(selected)
            switch press.characters.lowercased() {
            case "t": update(selected, SlackOverrides(type: SlackTriageText.nextType(current.type)), columns: columns)
            case "l":
                guard let change = SlackTriageText.nextLabel(current.label, names: labels.map(\.name)) else {
                    return .ignored
                }
                update(selected, change, columns: columns)
            case "d": toggleDismissed(selected, columns: columns)
            default: return .ignored
            }
        }
        return .handled
    }

    /// Saves a change. When it takes the selected item out of the list, the selection moves to its neighbour.
    private func update(_ item: TrackedItem, _ change: SlackOverrides, columns: [[String]]) {
        if change.status == .dismissed, !triage.showDismissed, selection == item.id {
            selection = SlackTriageText.successor(of: item.id, in: columns)
        }
        triage.update(item, change)
    }

    private func toggleDismissed(_ item: TrackedItem, columns: [[String]]) {
        let dismissed = SlackTriageText.triage(item).status == .dismissed
        update(item, SlackOverrides(status: dismissed ? .open : .dismissed), columns: columns)
    }

    private func openTrackingSettings(_ project: Project) {
        model.settingsTab = .project(project.id)
        openSettings()
    }
}

/// Table or Board, in the window toolbar.
struct SlackTriageLayoutPicker: View {
    @Binding var layout: SlackTriageLayout

    var body: some View {
        Picker("Layout", selection: $layout) {
            ForEach(SlackTriageLayout.allCases, id: \.self) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented).labelsHidden().fixedSize()
        .help("Show messages as a table or as a board by status")
    }
}

/// Row and card actions, shared by the table and the board.
struct SlackTriageRowActions {
    let start: (TrackedItem) -> Void
    let mission: (TrackedItem) -> Void
    let open: (TrackedItem) -> Void
    let toggleDismissed: (TrackedItem) -> Void
    let select: (TrackedItem) -> Void
    /// The status of the latest chat started from an item, if any.
    let chatStatus: (TrackedItem) -> SessionStatus?
}

// MARK: Filter bar

/// Type, label and channel filters, hidden and dismissed toggles, and the count. Search is in the toolbar.
struct SlackTriageFilterBar: View {
    let project: Project
    @Binding var filter: SlackTriageText.Filter
    @Binding var showDismissed: Bool
    let hiddenCount: Int
    let shown: Int
    let total: Int

    var body: some View {
        let labels = project.tracking?.slackLabels ?? []
        let channels = project.tracking?.slackChannels ?? []
        let names = project.tracking?.slackChannelNames ?? [:]
        HStack(spacing: 8) {
            Menu {
                Picker("Type", selection: $filter.type) {
                    Text("All Types").tag(SlackMessageType?.none)
                    Divider()
                    ForEach(SlackMessageType.ordered, id: \.self) { type in
                        Label(type.title, icon: type.icon).tag(SlackMessageType?.some(type))
                    }
                }
                .pickerStyle(.inline)
            } label: {
                ChipLabel(title: SlackTriageText.typeFilterTitle(filter.type))
            }
            .chipMenuStyle().fixedSize()
            Menu {
                Picker("Label", selection: $filter.label) {
                    Text("All Labels").tag(SlackTriageText.LabelFilter.all)
                    Text("No Label").tag(SlackTriageText.LabelFilter.none)
                    if !labels.isEmpty { Divider() }
                    ForEach(labels, id: \.name) { label in
                        Text(label.name).tag(SlackTriageText.LabelFilter.named(label.name))
                    }
                }
                .pickerStyle(.inline)
            } label: {
                ChipLabel(title: SlackTriageText.labelFilterTitle(filter.label), maxTitleWidth: 180)
            }
            .chipMenuStyle().fixedSize()
            if channels.count > 1 || filter.channel != nil {
                Menu {
                    Picker("Channel", selection: $filter.channel) {
                        Text("All Channels").tag(String?.none)
                        Divider()
                        ForEach(channels, id: \.self) { channel in
                            Text(TrackedChannelRef(id: channel, name: names[channel]).display).tag(String?.some(channel))
                        }
                    }
                    .pickerStyle(.inline)
                } label: {
                    ChipLabel(title: "Channel: \(filter.channel.map { TrackedChannelRef(id: $0, name: names[$0]).display } ?? "All")",
                              maxTitleWidth: 180)
                }
                .chipMenuStyle().fixedSize()
            }
            if hiddenCount > 0 || filter.showHidden {
                Toggle("Show hidden (\(hiddenCount))", isOn: $filter.showHidden)
                    .toggleStyle(.checkbox)
                    .help("Messages with a label marked Hide from Inbox")
            }
            Toggle("Show dismissed", isOn: $showDismissed).toggleStyle(.checkbox)
            Spacer(minLength: 8)
            Text(SlackTriageText.count(shown: shown, of: total))
                .font(.pilot(.caption)).monospacedDigit().foregroundStyle(Theme.mutedForeground)
                .lineLimit(1).fixedSize()
        }
        .font(.pilot(.label))
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}

// MARK: Table

/// Severity, summary, type, label, channel, replies, age and status. Status, channel and replies drop out, in
/// that order, as the list narrows.
private struct SlackTriageTable: View {
    let items: [TrackedItem]
    let hidden: Set<String>
    let selection: String?
    let now: Date
    let actions: SlackTriageRowActions
    @State private var width: CGFloat = 900

    var body: some View {
        let columns = SlackTriageColumns(width: width)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        ForEach(items) { item in
                            SlackTriageTableRow(item: item, hidden: hidden, selected: item.id == selection, now: now,
                                                columns: columns, actions: actions)
                                .id(item.id)
                        }
                    } header: {
                        header(columns)
                    }
                }
            }
            .onChange(of: selection) { _, id in
                if let id { proxy.scrollTo(id) }
            }
        }
        .background(GeometryReader { geometry in
            Color.clear
                .onAppear { width = geometry.size.width }
                .onChange(of: geometry.size.width) { _, value in width = value }
        })
    }

    private func header(_ columns: SlackTriageColumns) -> some View {
        HStack(spacing: SlackTriageColumns.spacing) {
            Color.clear.frame(width: SlackTriageColumns.severity, height: 1)
            Text("Summary").frame(maxWidth: .infinity, alignment: .leading)
            Text("Type").frame(width: SlackTriageColumns.type, alignment: .leading)
            Text("Label").frame(width: SlackTriageColumns.label, alignment: .leading)
            if columns.channel { Text("Channel").frame(width: SlackTriageColumns.channel, alignment: .leading) }
            if columns.replies { Text("Replies").frame(width: SlackTriageColumns.replies, alignment: .trailing) }
            Text("Age").frame(width: SlackTriageColumns.age, alignment: .trailing)
            if columns.status { Text("Status").frame(width: SlackTriageColumns.status, alignment: .leading) }
        }
        .font(.pilot(.caption, weight: .medium))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(Theme.background)
        .overlay(alignment: .bottom) { HairlineDivider() }
        .accessibilityHidden(true)
    }
}

/// Column widths of the triage table, and which optional columns fit.
struct SlackTriageColumns: Equatable {
    static let spacing: CGFloat = 12
    static let severity: CGFloat = 8
    static let type: CGFloat = 84
    static let label: CGFloat = 112
    static let channel: CGFloat = 124
    static let replies: CGFloat = 44
    static let age: CGFloat = 36
    static let status: CGFloat = 96
    /// The summary keeps at least this much.
    static let summary: CGFloat = 220

    var channel: Bool
    var replies: Bool
    var status: Bool

    init(width: CGFloat) {
        let fixed = 32 + Self.severity + Self.type + Self.label + Self.age + 4 * Self.spacing
        var room = width - fixed - Self.summary
        func take(_ column: CGFloat) -> Bool {
            guard room >= column + Self.spacing else { return false }
            room -= column + Self.spacing
            return true
        }
        let status = take(Self.status), channel = status && take(Self.channel)
        self.status = status
        self.channel = channel
        replies = channel && take(Self.replies)
    }
}

private struct SlackTriageTableRow: View {
    let item: TrackedItem
    let hidden: Set<String>
    let selected: Bool
    let now: Date
    let columns: SlackTriageColumns
    let actions: SlackTriageRowActions
    @State private var hovered = false

    var body: some View {
        let triage = SlackTriageText.triage(item)
        HStack(spacing: SlackTriageColumns.spacing) {
            SlackSeverityDot(severity: triage.severity).frame(width: SlackTriageColumns.severity)
            Text(item.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            SlackTypeLabel(type: triage.type).frame(width: SlackTriageColumns.type, alignment: .leading)
            SlackLabelTag(name: triage.label, hidden: triage.label.map(hidden.contains) ?? false)
                .frame(width: SlackTriageColumns.label, alignment: .leading)
            if columns.channel {
                Text(TrackedItemText.identifier(item)).lineLimit(1).truncationMode(.middle)
                    .frame(width: SlackTriageColumns.channel, alignment: .leading)
            }
            if columns.replies {
                Text(SlackTriageText.replies(item).map(String.init) ?? "–").monospacedDigit()
                    .frame(width: SlackTriageColumns.replies, alignment: .trailing)
            }
            Text(SessionTimeFormatting.relative(item.updatedAt, now: now)).monospacedDigit().lineLimit(1)
                .frame(width: SlackTriageColumns.age, alignment: .trailing)
            if columns.status {
                SlackStatusText(status: triage.status, chat: actions.chatStatus(item))
                    .frame(width: SlackTriageColumns.status, alignment: .leading)
            }
        }
        .font(.pilot(.caption))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(selected ? Theme.selected : hovered ? Theme.muted : .clear)
        .overlay(alignment: .bottom) { HairlineDivider(leading: 16) }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .onTapGesture { actions.select(item) }
        .contextMenu { SlackTriageMenu(item: item, actions: actions) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SlackTriageText.accessibilityLabel(item, now: now))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { actions.select(item) }
        .accessibilityAction(named: "Start chat") { actions.start(item) }
        .accessibilityAction(named: "Start mission") { actions.mission(item) }
        .accessibilityAction(named: triage.status == .dismissed ? "Restore" : "Dismiss") { actions.toggleDismissed(item) }
    }
}

// MARK: Board

/// Open, In progress and Done (and Dismissed when shown), each a scrolling column of cards.
private struct SlackTriageBoard: View {
    let columns: [SlackBoardColumn]
    let hidden: Set<String>
    let selection: String?
    let now: Date
    let actions: SlackTriageRowActions

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(columns, id: \.status) { column in
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(title: column.status.title, count: column.items.count).padding(.horizontal, 4)
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 8) {
                                ForEach(column.items) { item in
                                    SlackTriageCard(item: item, hidden: hidden, selected: item.id == selection, now: now,
                                                    actions: actions)
                                        .id(item.id)
                                }
                                if column.items.isEmpty {
                                    Text("Nothing here").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                                        .frame(maxWidth: .infinity).padding(.vertical, 16)
                                }
                            }
                            .padding(2)
                            .padding(.bottom, 12)
                        }
                        .onChange(of: selection) { _, id in
                            if let id, column.items.contains(where: { $0.id == id }) { proxy.scrollTo(id) }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }
}

private struct SlackTriageCard: View {
    let item: TrackedItem
    let hidden: Set<String>
    let selected: Bool
    let now: Date
    let actions: SlackTriageRowActions
    @State private var hovered = false

    var body: some View {
        let triage = SlackTriageText.triage(item)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                SlackSeverityDot(severity: triage.severity)
                SlackTypeLabel(type: triage.type)
                if triage.label != nil {
                    SlackLabelTag(name: triage.label, hidden: triage.label.map(hidden.contains) ?? false)
                }
                Spacer(minLength: 0)
                if let status = actions.chatStatus(item) { SessionStatusIcon(status: status) }
            }
            Text(item.title).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Text(SlackTriageText.meta(item, now: now)).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(selected ? Theme.selected : hovered ? Theme.muted : Theme.card))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control)
            .strokeBorder(selected ? Theme.faintForeground : Theme.border, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .onTapGesture { actions.select(item) }
        .contextMenu { SlackTriageMenu(item: item, actions: actions) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SlackTriageText.accessibilityLabel(item, now: now))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { actions.select(item) }
        .accessibilityAction(named: "Start chat") { actions.start(item) }
        .accessibilityAction(named: "Start mission") { actions.mission(item) }
        .accessibilityAction(named: triage.status == .dismissed ? "Restore" : "Dismiss") { actions.toggleDismissed(item) }
    }
}

private struct SlackTriageMenu: View {
    let item: TrackedItem
    let actions: SlackTriageRowActions

    var body: some View {
        Button("Start Chat") { actions.start(item) }
        Button("Start Mission…") { actions.mission(item) }
        Divider()
        Button("Open in Slack") { actions.open(item) }
        Button("Copy Link") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(item.url, forType: .string)
        }
        Divider()
        Button(SlackTriageText.triage(item).status == .dismissed ? "Restore" : "Dismiss") { actions.toggleDismissed(item) }
    }
}

// MARK: Pieces

/// Severity as a small dot. Only critical and high take a signal colour, and text or VoiceOver names it.
struct SlackSeverityDot: View {
    let severity: SlackSeverity

    var body: some View {
        Circle().fill(severity.color).frame(width: 8, height: 8)
            .help("\(severity.title) severity")
            .accessibilityLabel("\(severity.title) severity")
    }
}

struct SlackTypeLabel: View {
    let type: SlackMessageType

    var body: some View {
        HStack(spacing: 4) {
            PilotSymbol(type.icon).frame(width: 14)
            Text(type.title).lineLimit(1)
        }
        .font(.pilot(.caption))
        .foregroundStyle(type == .unknown ? Theme.faintForeground : Theme.mutedForeground)
    }
}

/// A project label as a hairline tag. Labels hidden from the Inbox use a dashed outline and fainter text.
struct SlackLabelTag: View {
    let name: String?
    var hidden = false

    var body: some View {
        if let name {
            Text(name)
                .font(.pilot(.caption))
                .foregroundStyle(hidden ? Theme.faintForeground : Theme.foreground)
                .lineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.small)
                    .strokeBorder(hidden ? Theme.faintForeground : Theme.border,
                                  style: StrokeStyle(lineWidth: 1, dash: hidden ? [3, 2] : [])))
                .help(hidden ? "\(name), hidden from the Inbox" : name)
        } else {
            Text("–").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground).accessibilityLabel("No label")
        }
    }
}

/// Local status, with the status icon of the chat started from the message, if any.
private struct SlackStatusText: View {
    let status: SlackLocalStatus
    let chat: SessionStatus?

    var body: some View {
        HStack(spacing: 4) {
            if let chat { SessionStatusIcon(status: chat) }
            Text(status.title).lineLimit(1)
        }
        .foregroundStyle(status == .open ? Theme.foreground : Theme.mutedForeground)
    }
}

// MARK: Inspector

/// The selected message: where it came from, its summary, the reclassify pickers and actions. Start Chat is
/// the one primary action.
struct SlackTriageInspector: View {
    let item: TrackedItem?
    let labels: [SlackProjectLabel]
    let now: Date
    @ObservedObject var actions: TrackedItemActions
    let error: String?
    let excerpt: SlackExcerptState
    let retryExcerpt: () -> Void
    let update: (SlackOverrides) -> Void
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let item {
            ScrollView { details(item).padding(16) }
        } else {
            Text("Select a message to triage it.")
                .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func details(_ item: TrackedItem) -> some View {
        let triage = SlackTriageText.triage(item)
        let client = model.client
        let link = TrackedItemText.linkSummary(
            sessionIds: item.sessionIds ?? item.sessionId.map { [$0] } ?? [],
            missionIds: item.missionIds ?? item.missionId.map { [$0] } ?? [],
            session: { client.session($0) }, mission: { client.mission($0) }, unread: { model.isUnread($0) })
        return VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(SlackTriageText.meta(item, now: now)).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1)
                Text(item.title).font(.pilot(.headline, weight: .semibold)).foregroundStyle(Theme.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            quote
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                pickerRow("Type") {
                    Picker("Type", selection: Binding(get: { triage.type }, set: { update(SlackOverrides(type: $0)) })) {
                        ForEach(SlackMessageType.ordered, id: \.self) { Text($0.title).tag($0) }
                    }
                }
                pickerRow("Label") {
                    Picker("Label", selection: Binding(get: { triage.label ?? "" }, set: { name in
                        update(name.isEmpty ? SlackOverrides(clearLabel: true) : SlackOverrides(label: name))
                    })) {
                        Text("None").tag("")
                        if let label = triage.label, !labels.contains(where: { $0.name == label }) {
                            Text(label).tag(label)
                        }
                        if !labels.isEmpty { Divider() }
                        ForEach(labels, id: \.name) { Text($0.name).tag($0.name) }
                    }
                }
                pickerRow("Severity") {
                    Picker("Severity", selection: Binding(get: { triage.severity },
                                                          set: { update(SlackOverrides(severity: $0)) })) {
                        ForEach(SlackSeverity.ordered, id: \.self) { Text($0.title).tag($0) }
                    }
                }
                pickerRow("Status") {
                    Picker("Status", selection: Binding(get: { triage.status },
                                                        set: { update(SlackOverrides(status: $0)) })) {
                        ForEach(SlackLocalStatus.ordered, id: \.self) { Text($0.title).tag($0) }
                    }
                }
            }
            if let note = SlackTriageText.overridden(triage.overrides) {
                Text(note).font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let link {
                TrackedLinkButton(link: link) { open(link.target) }
            }
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Button(link == nil ? "Start Chat" : "Start Another Chat") { actions.startChat(item, app: model) }
                        .buttonStyle(.borderedProminent)
                        .help("Open a new chat prefilled from this message. You review it before it starts.")
                    Button("Start Mission…") { actions.startMission(item, app: model) }
                }
                .disabled(actions.busy.contains(item.id))
                if let url = trackedBrowserURL(item.url) {
                    Link(destination: url) {
                        HStack(spacing: 3) {
                            Text("Open in Slack")
                            PilotSymbol(PilotIcon.openExternal)
                        }
                    }
                    .font(.pilot(.label))
                    .foregroundStyle(Theme.mutedForeground)
                }
            }
            if let message = error ?? actions.errors[item.id] {
                InlineProblem(message)
            }
            HairlineDivider()
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    KeyHint(key: "↑↓", label: "move")
                    KeyHint(key: "T", label: "type")
                    KeyHint(key: "L", label: "label")
                }
                HStack(spacing: 10) {
                    KeyHint(key: "↩", label: "start chat")
                    KeyHint(key: "D", label: "dismiss")
                }
                Text("Your changes stay in Pilot and teach this project's classifier. Nothing is written to Slack.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The message itself, below the classifier's summary. Read from Slack when selected, never stored.
    private var quote: some View {
        QuoteBlock {
            switch excerpt {
            case .loading:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Reading the message…")
                }
                .font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                .accessibilityElement(children: .combine)
            case let .loaded(message):
                if let author = message.author {
                    Text(author).font(.pilot(.caption, weight: .medium)).foregroundStyle(Theme.mutedForeground)
                        .lineLimit(1)
                }
                if message.text.isEmpty {
                    Text("No text, only attachments.").font(.pilot(.caption)).foregroundStyle(Theme.faintForeground)
                } else {
                    Text(message.text).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            case let .unavailable(reason):
                Text(reason).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Retry", action: retryExcerpt)
                    .buttonStyle(.link).font(.pilot(.caption))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Slack message")
    }

    private func pickerRow<Content: View>(_ title: String, @ViewBuilder picker: () -> Content) -> some View {
        GridRow {
            Text(title).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            picker().labelsHidden().pickerStyle(.menu).controlSize(.small).frame(width: 168, alignment: .leading)
        }
    }

    private func open(_ target: TrackedItemText.LinkSummary.Target) {
        switch target {
        case let .chat(id): model.selectedSessionId = id
        case let .mission(id): model.openMission(id)
        }
    }
}
