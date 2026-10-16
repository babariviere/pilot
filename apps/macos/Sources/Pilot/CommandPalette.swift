import AppKit
import PilotCore
import SwiftUI

// MARK: - Entries

/// One palette row: what it shows and what it does. Search only reads item (see PilotCore's CommandPalette).
struct CommandPaletteEntry {
    let item: CommandPaletteItem
    let icon: PilotIcon
    /// Faint text before the title, such as a task number or a Linear ID.
    var prefix: String? = nil
    /// Faint text after the title, such as the project of "New chat" or the chat an action applies to.
    var suffix: String? = nil
    /// A plain second line for rows that are not chats.
    var detail: String? = nil
    /// A chat's row shows the sidebar's second line and state corner.
    var session: SessionSummary? = nil
    /// The menu shortcut that does the same, such as ⌘N.
    var shortcut: String? = nil
    let perform: @MainActor () -> Void
}

/// Everything the palette can list, built from what the app already holds, plus the Inbox's Linear items and the
/// active missions' tasks, which the palette loads when it opens. Slack reports come from a search as you type.
@MainActor
struct CommandPaletteCatalog {
    let model: AppModel
    var inbox: Inbox?
    var missionDetails: [MissionDetail] = []
    let openSettings: () -> Void

    /// Recent chats listed while the field is empty.
    static let recentChats = 5

    init(model: AppModel, openSettings: @escaping () -> Void) {
        self.model = model
        self.openSettings = openSettings
    }

    func entries() -> [CommandPaletteEntry] {
        chats() + tasks() + missions() + projects() + pages() + actions() + tracked()
    }

    /// Chats by latest activity. The open chat is left out of the recent ones: it is already on screen.
    private func chats() -> [CommandPaletteEntry] {
        let client = model.client
        let sessions = client.activeSessions.sorted { $0.listActivityAt > $1.listActivityAt }
        var recent = 0
        return sessions.map { session in
            let suggested = session.id != model.selectedSessionId && recent < Self.recentChats
            if suggested { recent += 1 }
            let keywords = [client.project(session.projectId)?.name, session.branch,
                            session.missionId.flatMap { client.mission($0)?.title }].compactMap { $0 }
            return CommandPaletteEntry(
                item: CommandPaletteItem(id: "chat:\(session.id)", kind: .chat, title: session.title, keywords: keywords,
                                         pullRequestNumbers: session.linkedPullRequests.map(\.number),
                                         suggested: suggested),
                icon: .message, session: session
            ) { [model] in model.reveal(session: session.id) }
        }
    }

    /// Tasks of the active missions, open ones first. A task's pull requests are the ones linked to it.
    private func tasks() -> [CommandPaletteEntry] {
        missionDetails.flatMap { detail -> [CommandPaletteEntry] in
            let mission = detail.mission
            let ordered = detail.orderedTasks
            return (ordered.filter { !$0.status.isClosed } + ordered.filter(\.status.isClosed)).map { task in
                let pullRequests = detail.resources.filter { $0.taskId == task.id }.compactMap { resource in
                    resource.pullRequest?.number ?? CommandPalette.pullRequestNumber(fromURL: resource.url)
                }
                return CommandPaletteEntry(
                    item: CommandPaletteItem(id: "task:\(mission.id):\(task.id)", kind: .task, title: task.title,
                                             keywords: ["#\(task.number)", mission.title],
                                             pullRequestNumbers: pullRequests, taskNumber: task.number),
                    icon: .tasks, prefix: "#\(task.number)", detail: "\(mission.title) · \(task.workStatus.label)"
                ) { [model] in model.showMissionTask(task.id, in: mission) }
            }
        }
    }

    private func missions() -> [CommandPaletteEntry] {
        let missions = model.client.missions.filter { $0.status != .archived }.sorted { lhs, rhs in
            lhs.status == rhs.status ? lhs.updatedAt > rhs.updatedAt : lhs.status == .active
        }
        return missions.map { mission in
            let project = model.client.project(mission.projectId)?.name
            let progress = mission.tasksTotal.flatMap { total in
                total > 0 ? "\(mission.tasksDone ?? 0) of \(total) tasks done" : nil
            }
            return CommandPaletteEntry(
                item: CommandPaletteItem(id: "mission:\(mission.id)", kind: .mission, title: mission.title,
                                         keywords: [project].compactMap { $0 }),
                icon: .mission,
                detail: [project, mission.status == .done ? "Done" : nil, progress].compactMap { $0 }
                    .joined(separator: " · ")
            ) { [model] in model.showMission(mission) }
        }
    }

    /// Project scopes, as in the View menu (⌘0 to ⌘9).
    private func projects() -> [CommandPaletteEntry] {
        let focused = model.focusedProject?.id
        var entries: [CommandPaletteEntry] = []
        if focused != nil {
            entries.append(CommandPaletteEntry(
                item: CommandPaletteItem(id: "scope:all", kind: .project, title: "Show all projects"),
                icon: .allProjects, shortcut: "⌘0"
            ) { [model] in model.focus(on: nil) })
        }
        for (index, project) in model.orderedProjects.enumerated() where project.id != focused {
            entries.append(CommandPaletteEntry(
                item: CommandPaletteItem(id: "scope:\(project.id)", kind: .project, title: "Switch to \(project.name)",
                                         keywords: [project.name]),
                icon: .project, shortcut: index < 9 ? "⌘\(index + 1)" : nil
            ) { [model] in model.focus(on: project.id) })
        }
        return entries
    }

    private func pages() -> [CommandPaletteEntry] {
        let focused = model.focusedProject?.id
        var entries = [
            CommandPaletteEntry(item: CommandPaletteItem(id: "page:home", kind: .page, title: "Home", suggested: true),
                                icon: .home) { [model] in model.openHome() },
            CommandPaletteEntry(item: CommandPaletteItem(id: "page:inbox", kind: .page, title: "Inbox", suggested: true),
                                icon: .inbox) { [model] in model.showInbox() },
        ]
        let projects = model.orderedProjects
        for project in projects.filter({ $0.id == focused }) + projects.filter({ $0.id != focused }) {
            entries.append(CommandPaletteEntry(
                item: CommandPaletteItem(id: "page:overview:\(project.id)", kind: .page, title: "Overview",
                                         keywords: [project.name], suggested: project.id == focused),
                icon: .overview, suffix: project.name
            ) { [model] in model.showOverview(project.id) })
        }
        for project in projects.filter({ $0.id == focused }) + projects.filter({ $0.id != focused }) {
            entries.append(CommandPaletteEntry(
                item: CommandPaletteItem(id: "page:memory:\(project.id)", kind: .page, title: "Memory",
                                         keywords: [project.name, "notes", "summaries"]),
                icon: .memory, suffix: project.name
            ) { [model] in model.showMemory(project.id) })
        }
        entries.append(CommandPaletteEntry(item: CommandPaletteItem(id: "page:archive", kind: .page, title: "Archive"),
                                           icon: .archive) { [model] in model.showArchive(in: model.focusedProject?.id) })
        entries.append(CommandPaletteEntry(item: CommandPaletteItem(id: "page:settings", kind: .page, title: "Settings"),
                                           icon: .settings, shortcut: "⌘,", perform: openSettings))
        if let session = model.selectedSession, InspectorTab.agents.isAvailable(for: session) {
            entries.append(CommandPaletteEntry(
                item: CommandPaletteItem(id: "page:agents", kind: .page, title: "Agents"),
                icon: .subagents, suffix: session.title
            ) { [model] in model.showAgents() })
        }
        return entries
    }

    /// New chat in the current project (suggested) or a chosen one, then the open chat's actions.
    private func actions() -> [CommandPaletteEntry] {
        let scope = model.focusedProject ?? model.client.project(model.draftProjectId)
        var entries = [CommandPaletteEntry(
            item: CommandPaletteItem(id: "new:scope", kind: .action, title: "New chat", suggested: true),
            icon: .compose, suffix: scope.map { "in \($0.name)" }, shortcut: "⌘N"
        ) { [model] in model.newChatInScope() }]
        for project in model.orderedProjects where project.id != scope?.id {
            entries.append(CommandPaletteEntry(
                item: CommandPaletteItem(id: "new:\(project.id)", kind: .action, title: "New chat",
                                         keywords: [project.name]),
                icon: .compose, suffix: "in \(project.name)"
            ) { [model] in model.newSession(in: project.id) })
        }
        if let session = model.selectedSession { entries += chatActions(session, suggested: true) }
        return entries
    }

    /// What can be done to one chat: retry, stop, open or merge its PRs, pin or unpin, archive. For the open chat
    /// (suggested), the latest PR's row shows ⌘⇧P.
    func chatActions(_ session: SessionSummary, suggested: Bool = false) -> [CommandPaletteEntry] {
        guard !session.isArchived else { return [] }
        let id = session.id
        let model = model
        var entries: [CommandPaletteEntry] = []
        func add(_ key: String, _ title: String, _ icon: PilotIcon, namesChat: Bool = true, shortcut: String? = nil,
                 perform: @escaping @MainActor () -> Void) {
            entries.append(CommandPaletteEntry(
                item: CommandPaletteItem(id: "action:\(key):\(id)", kind: .action, title: title, suggested: suggested),
                icon: icon, suffix: namesChat ? session.title : nil, shortcut: shortcut, perform: perform))
        }
        if session.status == .failed {
            add("retry", "Retry", .refresh) { model.retry(session) }
        }
        if session.isWorking {
            add("stop", "Stop agent", .stop) { model.stopSession(id) }
        }
        let pullRequests = session.linkedPullRequests.filter { !$0.isTerminal }
            + session.linkedPullRequests.filter(\.isTerminal)
        let latest = suggested ? session.latestPullRequest?.url : nil
        for pullRequest in pullRequests {
            guard let url = pullRequest.browserURL else { continue }
            add("pr-\(pullRequest.number)", "Open PR #\(pullRequest.number) on GitHub", .openExternal, namesChat: false,
                shortcut: pullRequest.url == latest ? "⌘⇧P" : nil) {
                BrowserLinkOpener.shared.open(url)
            }
            if pullRequest.state == .open, session.projectId != nil, !session.isMissionCoordinator {
                add("merge-pr-\(pullRequest.number)", "Merge PR #\(pullRequest.number)…", .pullRequest) {
                    model.mergingPullRequest = PullRequestMergeTarget(sessionId: id, pullRequest: pullRequest)
                }
            }
        }
        add("pin", session.isPinned ? "Unpin" : "Pin", session.isPinned ? .unpin : .pin) {
            model.setPinned(!session.isPinned, sessionId: id)
        }
        if session.canArchive {
            add("archive", "Archive", .archive) { model.setArchived(true, sessionId: id) }
        }
        return entries
    }

    /// The Inbox's Linear items, opened as from the Inbox. Slack messages come from pilotd's search instead (see
    /// reports), which also reads their thread text and lists done ones.
    private func tracked() -> [CommandPaletteEntry] {
        (inbox?.linear?.items ?? []).map { item in
            let identifier = TrackedItemText.identifier(item)
            let project = model.client.project(item.projectId)?.name
            return CommandPaletteEntry(
                item: CommandPaletteItem(id: "tracked:\(item.id)", kind: .linear, title: item.title,
                                         keywords: [identifier, project].compactMap { $0 }),
                icon: .linearIssue, prefix: identifier,
                detail: [project, TrackedItemText.subtitle(item)].compactMap { $0 }
                    .filter { !$0.isEmpty }.joined(separator: " · ")
            ) {
                if let url = trackedBrowserURL(item.url) { BrowserLinkOpener.shared.open(url) }
            }
        }
    }

    /// Slack messages in triage that pilotd found for the query, latest first. The status leads, so a search for a
    /// client tells at once whether their report was resolved. Opens the message in its project's triage.
    func reports(_ items: [TrackedItem]) -> [CommandPaletteEntry] {
        items.map { item in
            let project = model.client.project(item.projectId)?.name
            return CommandPaletteEntry(
                item: CommandPaletteItem(id: "report:\(item.id)", kind: .slack, title: item.title),
                icon: .slackChannel,
                detail: [SlackTriageText.statusTitle(SlackTriageText.triage(item)), TrackedItemText.subtitle(item), project]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            ) { [model] in model.showSlackTriageItem(item) }
        }
    }

    /// A pasted Slack message link: add it to a project's Slack triage. Projects tracking the message's channel come
    /// first, then the focused one, then the others in sidebar order. With none tracking Slack, Settings.
    func slackLink(_ link: SlackMessageLink) -> [CommandPaletteEntry] {
        let focused = model.focusedProject?.id
        let tracking = InboxText.triageProjects(model.orderedProjects, sources: model.client.trackingSources, scope: nil)
        func rank(_ project: Project) -> Int {
            (project.tracking?.slackChannels ?? []).contains(link.channel) ? 0 : project.id == focused ? 1 : 2
        }
        let projects = tracking.enumerated()
            .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
            .map(\.element)
        guard !projects.isEmpty else {
            return [CommandPaletteEntry(
                item: CommandPaletteItem(id: "slack-link:settings", kind: .action, title: "Add to Slack triage"),
                icon: .slackChannel, detail: "No project tracks Slack yet. Add channels in Settings first.",
                perform: openSettings)]
        }
        let channel = projects.lazy.compactMap { $0.tracking?.slackChannelNames?[link.channel] }.first
        return projects.map { project in
            CommandPaletteEntry(
                item: CommandPaletteItem(id: "slack-link:\(project.id)", kind: .action, title: "Add to Slack triage"),
                icon: .slackChannel, suffix: "in \(project.name)",
                detail: [channel.map { "#\($0)" }, "Pilot reads and sorts the message, then opens triage"]
                    .compactMap { $0 }.joined(separator: " · ")
            ) { [model] in model.addSlackMessageToTriage(link, projectId: project.id) }
        }
    }
}

extension AppModel {
    /// Opens a mission, widening a focused sidebar that does not hold it, as reveal(session:) does for chats.
    func showMission(_ mission: Mission, tab: MissionTab? = nil) {
        if let scope = sidebarScope, scope != mission.projectId { focus(on: nil) }
        openMission(mission.id, tab: tab)
    }

    /// A mission's Tasks tab, scrolled to one task.
    func showMissionTask(_ taskId: String, in mission: Mission) {
        showMission(mission, tab: .tasks)
        revealedMissionTaskId = taskId
    }

    /// A project's Overview, focusing the sidebar on that project when another one is focused.
    func showOverview(_ projectId: String) {
        if let scope = sidebarScope, scope != projectId { focus(on: projectId) }
        openProject(projectId)
    }

    /// A project's Memory page, focusing the sidebar on that project when another one is focused.
    func showMemory(_ projectId: String) {
        if let scope = sidebarScope, scope != projectId { focus(on: projectId) }
        openMemory(projectId)
    }
}

// MARK: - Model

/// The palette's query, results and selection. The top match is always selected after the query changes.
@MainActor
final class CommandPaletteModel: ObservableObject {
    @Published var query = "" {
        didSet {
            guard query != oldValue else { return }
            refresh()
            searchReports()
        }
    }
    @Published private(set) var sections: [CommandPaletteSection] = []
    @Published var selection: String?
    private(set) var entries: [String: CommandPaletteEntry] = [:]
    private var items: [CommandPaletteItem] = []
    private var catalog: CommandPaletteCatalog?
    private var loading: Task<Void, Never>?
    private weak var client: PilotClient?
    /// Slack messages pilotd found for the current query, and the query they answer.
    private var reports: (query: String, items: [TrackedItem]) = ("", [])
    private var searching: Task<Void, Never>?

    /// Active missions whose tasks the palette loads, at most.
    static let missionLimit = 20
    /// Slack messages a search lists, latest first.
    static let reportLimit = 8
    /// Typing pause before pilotd searches Slack messages.
    static let searchDelay: Duration = .milliseconds(150)

    /// Lists what the app holds at once, then adds the Inbox's Linear items and the active missions'
    /// tasks when they arrive.
    func start(model: AppModel, openSettings: @escaping () -> Void) {
        catalog = CommandPaletteCatalog(model: model, openSettings: openSettings)
        client = model.client
        rebuild()
        loading?.cancel()
        loading = Task { [weak self] in
            let client = model.client
            let missions = client.missions.filter { $0.status == .active }.prefix(Self.missionLimit)
            let requests = missions.map { mission in
                Task { () -> MissionDetail? in
                    if let detail = client.missionDetails[mission.id] { return detail }
                    return try? await client.missionDetail(mission.id)
                }
            }
            let inbox = try? await client.inbox(projectId: nil)
            var details: [MissionDetail] = []
            for request in requests {
                if let detail = await request.value { details.append(detail) }
            }
            guard !Task.isCancelled, let self else { return }
            self.catalog?.inbox = inbox
            self.catalog?.missionDetails = details
            self.rebuild()
        }
    }

    func stop() {
        loading?.cancel()
        loading = nil
        searching?.cancel()
        searching = nil
    }

    /// Asks pilotd for Slack messages matching the query (words in their title, channel or thread text, or a pasted
    /// link's thread) after a short pause. Only the latest query's answer is kept.
    private func searchReports() {
        searching?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, trimmed.count >= 2, CommandPalette.number(in: trimmed) == nil else {
            if !reports.items.isEmpty { reports = ("", []); refresh(keepingSelection: true) }
            return
        }
        searching = Task { [weak self] in
            try? await Task.sleep(for: Self.searchDelay)
            guard !Task.isCancelled else { return }
            let found = (try? await client.searchSlack(trimmed, limit: Self.reportLimit))?.items ?? []
            guard !Task.isCancelled, let self,
                  self.query.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed else { return }
            self.reports = (trimmed, found)
            self.refresh(keepingSelection: true)
        }
    }

    private func rebuild() {
        guard let catalog else { return }
        let list = catalog.entries()
        items = list.map(\.item)
        entries = Dictionary(list.map { ($0.item.id, $0) }, uniquingKeysWith: { first, _ in first })
        refresh(keepingSelection: true)
    }

    private func refresh(keepingSelection: Bool = false) {
        guard let catalog else { return }
        var added: [CommandPaletteEntry] = []
        let entries = entries
        var results = CommandPalette.results(for: query, items: items) { chatId in
            guard let session = entries[chatId]?.session else { return [] }
            let actions = catalog.chatActions(session)
            added += actions
            return actions.map(\.item)
        }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let found = reports.query == trimmed ? catalog.reports(reports.items) : []
        let adding = SlackMessageLink(trimmed).map(catalog.slackLink) ?? []
        added += found + adding
        if !found.isEmpty {
            let section = CommandPaletteSection(id: "slack-reports", title: "Slack reports", items: found.map(\.item))
            // A pasted link names one message: show it first. Words list reports after closer matches.
            if adding.isEmpty { results.append(section) } else { results.insert(section, at: 0) }
        }
        if !adding.isEmpty {
            results.insert(CommandPaletteSection(id: "slack-link", title: "Slack message", items: adding.map(\.item)),
                           at: found.isEmpty ? 0 : 1)
        }
        sections = results
        for entry in added { self.entries[entry.item.id] = entry }
        let shown = order
        if !keepingSelection || !(selection.map(shown.contains) ?? false) { selection = shown.first }
    }

    /// Row ids in the order shown.
    var order: [String] { sections.flatMap { $0.items.map(\.id) } }

    /// Moves the selection up or down, stopping at either end.
    func move(by offset: Int) {
        let shown = order
        guard !shown.isEmpty else { return }
        let index = selection.flatMap(shown.firstIndex(of:)) ?? 0
        selection = shown[min(max(index + offset, 0), shown.count - 1)]
    }
}

// MARK: - View

/// The ⌘K command palette: one search field over one list, grouped by kind, with the top match selected. Chats,
/// pull request numbers, pages, missions and tasks, actions, project scopes, the Inbox's Linear items, and Slack
/// reports in triage (title, channel or thread text, latest first, resolved ones included). A pasted Slack message
/// link finds that report and offers to add it to a project's triage. Arrow keys move, Return opens, Escape closes.
/// Rows wear the sidebar's state corner, grey except the amber of Needs you. Searching inside transcripts is not
/// covered.
struct CommandPaletteView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openSettings) private var openSettings
    @Environment(\.dismiss) private var dismiss
    @StateObject private var palette = CommandPaletteModel()
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            field
            HairlineDivider()
            results
            HairlineDivider()
            HStack(spacing: 14) {
                KeyHint(key: "↑↓", label: "Move")
                KeyHint(key: "↩", label: "Open")
                KeyHint(key: "esc", label: "Close")
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        }
        .frame(width: 620, height: 520)
        .background(Theme.background)
        .onAppear {
            palette.start(model: model, openSettings: { openSettings() })
            fieldFocused = true
        }
        .onDisappear { palette.stop() }
    }

    private var field: some View {
        HStack(spacing: 10) {
            PilotSymbol(PilotIcon.search).foregroundStyle(Theme.faintForeground)
            TextField("Search chats, pages, missions and Slack reports, or paste a Slack link", text: $palette.query)
                .textFieldStyle(.plain)
                .font(.pilot(.headline))
                .focused($fieldFocused)
                .onSubmit { run(palette.selection) }
                .onKeyPress(.downArrow) {
                    palette.move(by: 1)
                    return .handled
                }
                .onKeyPress(.upArrow) {
                    palette.move(by: -1)
                    return .handled
                }
                .onExitCommand { dismiss() }
                .accessibilityLabel("Search")
            KeyCap(key: "esc").foregroundStyle(Theme.mutedForeground)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var results: some View {
        ScrollViewReader { proxy in
            ScrollView {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    VStack(alignment: .leading, spacing: 0) {
                        if palette.sections.isEmpty {
                            Text(palette.query.isEmpty ? "Nothing to list yet." : "No matches.")
                                .font(.pilot(.body)).foregroundStyle(Theme.mutedForeground)
                                .padding(.horizontal, 10).padding(.vertical, 14)
                        }
                        ForEach(palette.sections) { section in
                            SectionLabel(title: section.title)
                                .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 4)
                                .accessibilityAddTraits(.isHeader)
                            ForEach(Array(section.items.enumerated()), id: \.element.id) { index, item in
                                if index > 0 { HairlineDivider(leading: 36) }
                                if let entry = palette.entries[item.id] {
                                    Button { run(item.id) } label: {
                                        CommandPaletteRow(entry: entry, selected: palette.selection == item.id,
                                                          now: context.date)
                                    }
                                    .buttonStyle(.plain)
                                    .focusable(false)
                                    .id(item.id)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 8)
                }
            }
            .onChange(of: palette.selection) { _, id in
                if let id { proxy.scrollTo(id) }
            }
        }
    }

    private func run(_ id: String?) {
        guard let id, let entry = palette.entries[id] else { return }
        model.commandPaletteAction = entry.perform
        dismiss()
    }
}

/// A palette row: icon, title with its faint prefix or suffix, a second line, then the shortcut and, on the
/// selected row, Return. Chat rows read like their sidebar row, corner included.
private struct CommandPaletteRow: View {
    let entry: CommandPaletteEntry
    let selected: Bool
    let now: Date
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let session = entry.session
        let unread = session.map { model.isUnread($0) || model.isHeld($0) } ?? false
        let state = session?.signal(unread: unread)
        // Failed chats are in Needs you: the palette's only colour is its amber.
        let signal: SessionSignal? = state == .failed ? .needsYou : state
        HStack(spacing: 10) {
            PilotSymbol(entry.icon).foregroundStyle(Theme.mutedForeground).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let prefix = entry.prefix {
                        Text(prefix).foregroundStyle(Theme.faintForeground).monospacedDigit().fixedSize()
                    }
                    Text(entry.item.title).foregroundStyle(Theme.foreground).lineLimit(1)
                    if let suffix = entry.suffix {
                        Text(suffix).foregroundStyle(Theme.faintForeground).lineLimit(1)
                    }
                }
                .font(.pilot(.body))
                if let session {
                    // An unsent draft replaces the details after the project, as on the chat's sidebar row.
                    RowLine(segments: RowLineSegments.shown(segments(session, unread: unread),
                                                            draft: model.chatDraft(session.id)))
                } else if let detail = entry.detail, !detail.isEmpty {
                    Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            HStack(spacing: 3) {
                if let shortcut = entry.shortcut { KeyCap(key: shortcut) }
                if selected { KeyCap(key: "↩") }
            }
            .foregroundStyle(Theme.mutedForeground)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, session == nil && (entry.detail ?? "").isEmpty ? 7 : 5)
        .padding(.trailing, signal == nil ? 0 : 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .ditherCorner(signal, background: session?.isWaitingOnJobs == true, monochrome: true)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.row).fill(selected ? Theme.selected : .clear))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func segments(_ session: SessionSummary, unread: Bool) -> [RowLineSegment] {
        let client = model.client
        let reason = session.needsYouReason(unread: unread, now: now)?
            .label(at: session.outcomeAt ?? session.updatedAt, now: now)
        return RowLineSegments.session(
            session, projectName: client.project(session.projectId)?.name, missionId: session.missionId,
            missionTitle: session.missionId.flatMap { client.mission($0)?.title }, reason: reason,
            branch: session.branch,
            coordinatorDetail: session.isMissionCoordinator ? MissionCoordinatorStatus.detail(session, unread: unread) : nil)
    }
}
