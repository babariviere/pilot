import AppKit
import PilotCore
import SwiftUI

/// Missions, then chats by urgency (Pinned, Needs you, Ready to merge, Working, Recent), each in PR status and stable
/// activity order. The scope switcher at the top lists every project (the default) or focuses on one, which then shows
/// only that project's missions and chats, without project names. The control chat sits in a fixed slot under the
/// switcher in every scope (`SidebarControlSlot`), never in the scrolling list. Project folders are headings in the
/// scope switcher and on Home, never a sidebar grouping. Search appears on ⌘F, and the footer only when the
/// connection to pilotd needs attention. Each chat's state is its dithered corner (`DitherCorner`).
struct SessionSidebar: View {
    @Environment(\.hostViewContext) private var hostContext
    @ObservedObject var model: AppModel
    @ObservedObject var client: PilotClient
    @ObservedObject private var hosts: HostClients
    @ObservedObject private var missionRegistry: MissionRegistry
    @StateObject private var folderEditor = ProjectFolderEditorState()

    @FocusState private var searchFocused: Bool
    @FocusState private var chatListFocused: Bool
    /// Lines the Missions header's + up with the compose button and Inbox badge above it. The header stays full
    /// width under the scroll bar, so without this inset the + sat beneath it and lost clicks.
    private static let missionsAddTrailingInset: CGFloat = 16

    init(model: AppModel, client: PilotClient) {
        self.model = model; self.client = client
        self.hosts = model.hosts; self.missionRegistry = model.missionRegistry
    }

    var body: some View {
        let known = Set(client.projects.map(\.id))
        let visible = client.activeSessions.filter(matches)
        let searching = !model.sidebarQuery.trimmingCharacters(in: .whitespaces).isEmpty
        let counts = client.projectCounts.projects
        let focused = model.focusedProject
        let showsSearch = model.sidebarSearchVisible || searching
        // Archived chats join the list only while searching, below the active ones.
        let archived = searching
            ? ArchiveFilter(projectId: focused?.id).apply(to: client.archivedSessions.filter(matches)) : []
        List(selection: Binding(get: { model.selectedSessionId }, set: { key in
            guard let key else { return }
            model.navigate(.session, id: key)
        })) {
            if model.localHost != nil { unifiedMissions(query: model.sidebarQuery) }
            if !hosts.offlineHosts.isEmpty {
                unifiedRows
            } else if let focused {
                if model.localHost == nil { missionsSection(visible: visible, searching: searching, projectId: focused.id) }
                urgencyGroups(visible.filter { $0.projectId == focused.id }, searching: searching,
                              recentListId: focused.id, hasArchivedMatches: !archived.isEmpty)
                archivedMatches(archived)
            } else {
                if model.localHost == nil { missionsSection(visible: visible, searching: searching) }
                let names = Dictionary(client.projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
                urgencyGroups(visible, searching: searching, recentListId: Self.recentListId,
                              hasArchivedMatches: !archived.isEmpty, projectNames: names)
                archivedMatches(archived, projectNames: names)
            }
        }
        .listStyle(.sidebar)
        .focused($chatListFocused)
        .keyboardRegion(.sidebar) {
            if model.keyboard.focusFirstKeyView(in: .sidebar, where: { $0 is NSTableView }) { return true }
            chatListFocused = true
            return true
        }
        .onChange(of: chatListFocused) { _, focused in
            if focused { model.keyboard.noteFocused(.sidebar) }
        }
        .focusEffectDisabled()
        .scrollContentBackground(.hidden)
        .background(Theme.sidebar)
        .overlay {
            if client.projects.isEmpty, client.sessions.isEmpty, hosts.projects.isEmpty, hosts.sessions.isEmpty {
                EmptyStateView(icon: PilotIcon.newProject, title: "No projects yet",
                               message: "Add a project to get started.") {
                    Button("Add Project…") { model.addProject() }
                    Button("Import GitHub Project…") { model.importGitHubProject() }
                }
                .padding(.horizontal, 12)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            // Home and the Inbox cover every project; the selector heads the scoped list below them. Archived
            // chats live in the selector's menu, search behind ⌘F (which also finds archived chats).
            let needsYou = SidebarScopeCounts.total(counts).needsYou
            let archivedCount = focused.map { project in
                client.archivedSessions.filter { $0.projectId == project.id }.count
            } ?? client.archivedSessions.count
            let controls = model.sidebarControlRows
            VStack(spacing: 6) {
                SidebarHeader(model: model, client: client, counts: counts, homeSelected: homeSelected,
                              inboxSelected: inboxSelected, overviewSelected: overviewSelected(focused),
                              needsYou: needsYou,
                              needsYouHelp: SidebarScopeCounts.needsYouReasons(total: needsYou,
                                                                               reasons: needsYouReasons, counts: counts),
                              archivedCount: archivedCount, folderEditor: folderEditor)
                if !controls.isEmpty {
                    SidebarControlSlot(rows: controls, model: model)
                }
                if showsSearch {
                    SearchField(text: $model.sidebarQuery, focused: $searchFocused) { model.hideSidebarSearch() }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 6)
            // The list scrolls beneath this inset; keep its rows from showing through the fixed rows.
            .background(Theme.sidebar)
            .animation(Theme.Motion.quick, value: showsSearch)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // Quiet while connected. Working counts live in the rows' corners.
            VStack(spacing: 0) {
                if client.connected { McpSignInFooter() }
                if !client.connected {
                    ConnectionFooter()
                        // The list can draw beneath its safe-area inset while scrolling.
                        // Keep session metadata from showing through the status text.
                        .background(Theme.sidebar)
                        .overlay(alignment: .top) {
                            Rectangle().fill(Theme.border).frame(height: 1)
                        }
                        .transition(.opacity)
                }
            }
            .animation(Theme.Motion.quick, value: client.connected)
        }
        .onChange(of: model.sidebarSearchFocusRequest) {
            // The field may only now be inserted. Focus it once it exists.
            DispatchQueue.main.async { searchFocused = true }
        }
        .onChange(of: searchFocused) { _, focused in
            if !focused, model.sidebarQuery.trimmingCharacters(in: .whitespaces).isEmpty {
                model.hideSidebarSearch()
            }
        }
        .onAppear {
            model.validateSidebarScope()
            model.keyboard.sidebarStickyRows = KeyboardFocus.StickyRows(
                keys: { [model] in model.sidebarControlRows.map(\.key) },
                current: { [model] in model.selectedSessionId },
                select: { [model] key in model.navigate(.session, id: key) })
        }
        .onDisappear { model.keyboard.sidebarStickyRows = nil }
        .onChange(of: known) { model.validateSidebarScope() }
        .sheet(isPresented: $folderEditor.presented) {
            ProjectFolderEditor(editor: folderEditor) {
                if let id = folderEditor.folderId {
                    model.projectFolders.rename(id, name: folderEditor.name)
                } else if let folder = model.projectFolders.create(name: folderEditor.name),
                          let projectId = folderEditor.projectId {
                    model.projectFolders.move(projectId: projectId, to: folder.id)
                }
                folderEditor.presented = false
            }
        }
    }

    @ViewBuilder private var unifiedRows: some View {
        let query = model.sidebarQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let scopedProjects = model.focusedProjectRef.flatMap { focused in
            model.navigationProjectGroups.first { $0.checkouts.contains { $0.ref == focused } }
        }.map { Set($0.checkouts.map(\.ref)) }
        let values = hosts.sessions.filter { hosted in
            (!hosted.value.isArchived || !query.isEmpty) && (query.isEmpty || hosted.value.title.lowercased().contains(query))
                && (model.focusedProjectRef == nil || hosted.value.projectId.map {
                    scopedProjects?.contains(HostResourceRef(host: hosted.ref.host, kind: .project, localId: $0)) == true
                } == true)
        }.sorted { $0.value.listActivityAt > $1.value.listActivityAt }
        // Each host's control chat lives in the fixed slot above the list (`SidebarControlSlot`).
        ForEach(["Pinned", "Needs you", "Ready to merge", "Working", "Recent", "Archived"], id: \.self) { title in
            let rows = values.filter { !$0.value.isControl && group($0) == title }
            if !rows.isEmpty {
                Section {
                    ForEach(rows) { item in
                        let context = HostViewContext(host: item.ref.host, hosts: hosts)
                        SessionRow(session: item.value, reference: item.ref,
                            projectName: [hosts.projects.first { $0.ref.host == item.ref.host && $0.value.id == item.value.projectId }?.value.name,
                                          item.ref.host == model.localHost ? nil : context.name].compactMap { $0 }.joined(separator: " · "))
                            .environment(\.hostViewContext, context)
                            .tag(item.ref.host == model.localHost ? item.ref.localId : item.ref.storageKey)
                    }
                } header: { SidebarSectionHeader(title: title) }
            }
        }
    }

    @ViewBuilder private func unifiedMissions(query: String) -> some View {
        let missions = missionRegistry.rows.filter { query.isEmpty || ($0.title ?? "Mission").localizedCaseInsensitiveContains(query) }
        let active = missions.filter { $0.status == .active || $0.status == nil }
        let inactive = missions.filter { $0.status != .active && $0.status != nil }
        if !missions.isEmpty || missionRegistry.truncated || !missionRegistry.failures.isEmpty {
            Section {
                ForEach(active) { LogicalMissionSidebarRow(mission: $0, model: model, registry: missionRegistry) }
                if active.isEmpty, query.isEmpty {
                    Text("No active missions").font(.pilot(.small)).foregroundStyle(Theme.faintForeground)
                        .selectionDisabled(true)
                }
                if !inactive.isEmpty {
                    let showing = !query.isEmpty || model.showingInactiveMissions
                    SidebarDisclosureRow(title: "Done and archived (\(inactive.count))", expanded: showing) {
                        model.showingInactiveMissions.toggle()
                    }.selectionDisabled(true)
                    if showing { ForEach(inactive) { LogicalMissionSidebarRow(mission: $0, model: model, registry: missionRegistry) } }
                }
                if missionRegistry.truncated {
                    Text("More missions may be available").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        .selectionDisabled(true)
                }
                if !missionRegistry.failures.isEmpty {
                    Text("Some mission summaries could not refresh").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                        .selectionDisabled(true)
                }
            } header: { SidebarSectionHeader(title: "Missions") }
        }
    }

    private func group(_ item: Hosted<SessionSummary>) -> String {
        let value = item.value
        if value.isArchived { return "Archived" }
        if value.isPinned { return "Pinned" }
        let unread = model.isUnread(value, on: item.ref.host)
        switch value.signal(unread: unread) {
        case .working: return "Working"
        case .failed, .needsYou: return "Needs you"
        case .readyToMerge: return "Ready to merge"
        case nil: return "Recent"
        }
    }

    /// Home is selected when the detail shows it, in any scope.
    private var homeSelected: Bool {
        model.selectedSessionId == nil && model.selectedMissionId == nil && model.selectedProjectId == nil
            && !model.showingArchive && !model.showingInbox && !model.showingControl
    }

    private func overviewSelected(_ focused: Project?) -> Bool {
        guard let focused else { return false }
        return model.selectedSessionId == nil && model.selectedProjectId == focused.id
    }

    /// Why every project's chats need the user, for the Inbox badge's tooltip. Like pilotd's counts, read results
    /// no longer count (even while their chat is open) and pinned chats count by their state.
    private var needsYouReasons: NeedsYouReasons {
        let unread = { (session: SessionSummary) in model.isUnread(session) }
        let groups = SidebarUrgency.groups(client.activeSessions, unread: unread, separatingPinned: false)
        return NeedsYouReasons(groups.needsYou, unread: unread)
    }

    private var inboxSelected: Bool {
        model.showingInbox && !model.showingControl && model.selectedSessionId == nil && model.selectedMissionId == nil
            && model.selectedProjectId == nil
    }

    /// Chats by urgency, pinned chats first in their own group. Mission chats are listed like any chat, their
    /// mission on the second line. With `projectNames` (All projects) each row names its project; a focused project
    /// leaves it out. Projects and their folders live in the scope switcher and on Home. Ready to merge waits on the
    /// user but never badges. A result read in the open chat keeps its group until the user leaves the chat.
    @ViewBuilder
    private func urgencyGroups(_ sessions: [SessionSummary], searching: Bool, recentListId: String,
                               hasArchivedMatches: Bool = false, projectNames names: [String: String]? = nil) -> some View {
        let groups = SidebarUrgency.groups(sessions, unread: { model.isUnread($0) },
                                           held: { model.isHeld($0) })
        if !groups.pinned.isEmpty {
            Section {
                ForEach(groups.pinned) { session in
                    SessionRow(session: session, projectName: projectName(session, names))
                        .tag(session.id)
                }
            } header: {
                SidebarSectionHeader(title: "Pinned")
            }
        }
        if !groups.needsYou.isEmpty {
            Section {
                ForEach(groups.needsYou) { session in
                    SessionRow(session: session, projectName: projectName(session, names))
                        .tag(session.id)
                }
            } header: {
                SidebarSectionHeader(title: "Needs you", count: groups.needsYou.count, attention: true)
            }
        }
        if !groups.readyToMerge.isEmpty {
            Section {
                ForEach(groups.readyToMerge) { session in
                    SessionRow(session: session, projectName: projectName(session, names))
                        .tag(session.id)
                }
            } header: {
                SidebarSectionHeader(title: "Ready to merge")
            }
        }
        if !groups.working.isEmpty {
            Section {
                ForEach(groups.working) { session in
                    SessionRow(session: session, projectName: projectName(session, names))
                        .tag(session.id)
                }
            } header: {
                SidebarSectionHeader(title: "Working", count: groups.working.count)
            }
        }
        if !groups.recent.isEmpty {
            Section {
                projectSessions(groups.recent, listId: recentListId, searching: searching, projectNames: names)
            } header: {
                SidebarSectionHeader(title: "Recent")
            }
        }
        if groups.isEmpty, !hasArchivedMatches, !client.projects.isEmpty {
            Text(searching ? "No matching chats" : "No chats yet")
                .font(.pilot(.small)).foregroundStyle(Theme.faintForeground)
                .selectionDisabled(true)
        }
    }

    /// Archived chats matching the search, most recently archived first. Selecting one reads it, as in the Archive.
    @ViewBuilder
    private func archivedMatches(_ sessions: [SessionSummary], projectNames names: [String: String]? = nil) -> some View {
        if !sessions.isEmpty {
            Section {
                ForEach(sessions) { session in
                    SessionRow(session: session, projectName: projectName(session, names))
                        .tag(session.id)
                }
            } header: {
                SidebarSectionHeader(title: "Archived")
            }
        }
    }

    private func projectName(_ session: SessionSummary, _ names: [String: String]?) -> String? {
        guard let names, let id = session.projectId else { return nil }
        return names[id]
    }

    @ViewBuilder
    private func missionsSection(visible: [SessionSummary], searching: Bool, projectId: String? = nil) -> some View {
        let query = model.sidebarQuery.trimmingCharacters(in: .whitespaces).lowercased()
        let matching = client.missions.filter { mission in
            (projectId == nil || mission.projectId == projectId)
                && (!searching || mission.title.lowercased().contains(query)
                    || visible.contains { $0.missionId == mission.id })
        }
        let active = matching.filter { $0.status == .active }.sidebarOrder
        let inactive = matching.filter { $0.status != .active }.sidebarOrder
        // Hidden until a mission exists; "New Mission…" lives in the add menu and project menus.
        if !matching.isEmpty {
            Section {
                ForEach(active) { mission in
                    missionRow(mission)
                }
                if active.isEmpty, !searching {
                    Text("No active missions").font(.pilot(.small)).foregroundStyle(Theme.faintForeground)
                        .selectionDisabled(true)
                }
                if !inactive.isEmpty {
                    let showing = searching || model.showingInactiveMissions
                    SidebarDisclosureRow(title: "Done and archived (\(inactive.count))", expanded: showing) {
                        model.showingInactiveMissions.toggle()
                    }
                    .selectionDisabled(true)
                    if showing {
                        ForEach(inactive) { mission in
                            missionRow(mission)
                        }
                    }
                }
            } header: {
                HStack(spacing: 6) {
                    PilotSymbol(PilotIcon.mission).frame(width: 14)
                    Text("Missions").font(.pilot(.caption, weight: .semibold))
                    Spacer(minLength: 0)
                    Button { model.presentMissionSheet(.create(projectId: projectId), context: hostContext) } label: { PilotSymbol(PilotIcon.add) }
                        .buttonStyle(.borderless)
                        .frame(width: 16, height: 16)
                        .help("New mission…")
                        .accessibilityLabel("New mission")
                }
                .padding(.trailing, Self.missionsAddTrailingInset)
                .contextMenu {
                    Button("New Mission…") { model.presentMissionSheet(.create(projectId: projectId), context: hostContext) }
                }
            }
        }
    }

    /// A mission summarises its chats, which the chat lists show like any other chat. Counts use every active
    /// member, not only those matching the search.
    private func missionRow(_ mission: Mission) -> some View {
        let members = model.members(of: mission).filter { !$0.isArchived }
        return MissionSidebarRow(
            mission: mission, needsYou: model.needsYouCount(mission),
            working: members.filter(\.isWorking).count,
            signal: MissionSidebarSummary.signal(mission: mission, members: members,
                                                 isUnread: { model.isUnread($0) }),
            waitingOnJobs: MissionSidebarSummary.waitingOnJobs(mission: mission, members: members),
            selected: model.selectedMissionId == mission.id && model.selectedSessionId == nil)
            .selectionDisabled(true)
    }

    @ViewBuilder
    private func projectSessions(_ sessions: [SessionSummary], listId: String, searching: Bool,
                                 projectNames: [String: String]? = nil) -> some View {
        let showingAll = searching || model.expandedSessionLists.contains(listId)
        let collapsed = SidebarSessionList.collapsed(sessions) { session in
            session.id == model.selectedSessionId || session.isReadyToMerge || session.status == .question
                || model.isUnread(session)
        }
        let list = showingAll ? (shown: sessions, hidden: 0) : collapsed
        ForEach(list.shown) { session in
            SessionRow(session: session, projectName: projectName(session, projectNames))
                .tag(session.id)
        }
        if sessions.isEmpty {
            Text("No sessions").font(.pilot(.small)).foregroundStyle(Theme.faintForeground)
                .selectionDisabled(true)
        }
        if list.hidden > 0 {
            SidebarDisclosureRow(title: "\(list.hidden) quiet \(list.hidden == 1 ? "chat" : "chats")", expanded: false) {
                model.expandedSessionLists.insert(listId)
            }
            .selectionDisabled(true)
        } else if !searching, showingAll, collapsed.hidden > 0 {
            SidebarDisclosureRow(title: "Show fewer", expanded: true) {
                model.expandedSessionLists.remove(listId)
            }
            .selectionDisabled(true)
        }
    }

    /// The Recent section of All projects. A focused project's Recent uses its id.
    static let recentListId = "pilot.sidebar.recent"

    private func matches(_ session: SessionSummary) -> Bool {
        let query = model.sidebarQuery.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return true }
        return ([session.title, session.branch ?? "", session.cwd, session.model ?? ""]
                + session.linkedPullRequests.flatMap { [$0.label, $0.title, $0.branch ?? ""] })
            .contains { $0.lowercased().contains(query) }
    }
}

/// Quiet in-list toggle for secondary sidebar rows: folded chats or finished missions.
/// Use it instead of one-off chevron buttons so every sidebar disclosure reads the same.
struct SidebarDisclosureRow: View {
    let title: String
    let expanded: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                DisclosureChevron(expanded: expanded, tint: Theme.mutedForeground).frame(width: 14)
                Text(title).font(.pilot(.small))
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.mutedForeground)
            .contentShape(Rectangle())
        }
        .rowButtonStyle()
        .accessibilityLabel(title)
    }
}

/// Header of an urgency section in the sidebar, matching the Missions header's type.
private struct SidebarSectionHeader: View {
    let title: String
    var count: Int?
    var attention = false

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.pilot(.caption, weight: .semibold))
            if let count, count > 0 {
                CountBadge(count: count, style: attention ? .attention : .neutral)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One chat: its title, then one `RowLine` with its project (when the list is not grouped by project), what kind
/// of chat it is, its reason, PRs, mission and branch. An active coordinator's second line says "Coordinator" and
/// its state instead. The control chat leads its title with its own symbol, says "All projects" where others name
/// their project, and offers no pin, archive or mission actions. The dithered corner carries the chat's state, so
/// the row needs no status column. Time and
/// pin marks show under the pointer, in space the row always reserves, so hovering never reflows the title; the
/// corner recedes to make room for them. The mission label opens its mission. Diff counts stay out of the row and
/// appear in its tooltip, with every PR and the full second line.
struct SessionRow: View {
    let session: SessionSummary
    var reference: HostResourceRef? = nil
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var endpoint
    /// Shown before the repository metadata in lists that mix projects.
    var projectName: String?
    @EnvironmentObject private var model: AppModel
    @State private var hovered = false
    @State private var repositoryHelp: String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            row(now: context.date)
        }
        .listRowBackground(SidebarSelectionBackground(selected: model.selectedSessionId == rowKey))
    }

    private var owner: HostResourceRef? { reference ?? model.resourceRef(session.id, kind: .session, context: hostContext) }
    private var rowKey: String { owner.map { $0.host == model.localHost ? $0.localId : $0.storageKey } ?? session.id }
    private var disconnected: Bool { owner.map { $0.host != model.localHost && !model.hosts.available.contains($0.host) } ?? false }

    @ViewBuilder private func row(now: Date) -> some View {
        let unread = owner.map { model.isUnread(session, on: $0.host) } ?? model.isUnread(session)
        let needsAttention = unread || model.isHeld(session)
        let signal = session.signal(unread: needsAttention)
        let reason = session.needsYouReason(unread: needsAttention)?.label(at: session.outcomeAt ?? session.updatedAt, now: now)
        let missionTitle = session.missionId.flatMap { endpoint.mission($0)?.title }
        let coordinatorDetail = session.isMissionCoordinator
            ? MissionCoordinatorStatus.detail(session, unread: needsAttention) : nil
        let draft = owner.flatMap { model.chatDraft(for: $0) } ?? model.chatDraft(session.id)
        // Branch-free segments for the label and tooltip; the line itself adds the loaded branch.
        let described = RowLineSegments.described(
            RowLineSegments.session(session, projectName: projectName, missionId: session.missionId,
                                    missionTitle: missionTitle, reason: reason, coordinatorDetail: coordinatorDetail),
            draft: draft)
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if session.isControl {
                    PilotSymbol(PilotIcon.controlChat)
                        .foregroundStyle(Theme.foreground)
                        .accessibilityHidden(true)
                }
                Text(session.title)
                    .font(.pilot(.body, weight: unread ? .semibold : .regular))
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let source = session.trackedSource { TrackedSourceGlyph(source: source) }
                RemoteChatBadge(context: owner.map { HostViewContext(host: $0.host, hosts: model.hosts) })
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    // The control chat is always pinned and always first, so the mark would say nothing.
                    if session.isPinned, !session.isControl {
                        PilotSymbol(PilotIcon.pin, filled: true)
                            .foregroundStyle(Theme.foreground)
                            .help("Pinned chat. Automatic archiving is disabled until unpinned.")
                            .accessibilityLabel("Pinned chat")
                    }
                    if reason == nil {
                        Text(SessionTimeFormatting.relative(session.listActivityAt, now: now))
                            .font(.pilot(.small))
                            .foregroundStyle(Theme.mutedForeground)
                            .monospacedDigit()
                            .fixedSize()
                    }
                }
                .revealed(hovered)
            }
            if disconnected {
                Text("Disconnected · Current state unknown").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
            SessionRepositoryMetadata(session: session, hovered: hovered) { branch in
                RowLine(segments: RowLineSegments.shown(RowLineSegments.session(
                    session, projectName: projectName, missionId: session.missionId, missionTitle: missionTitle,
                    reason: reason, branch: branch, coordinatorDetail: coordinatorDetail), draft: draft)) {
                    model.openMission($0, context: hostContext)
                }
            }
            // Fade out before the corner's dense cells.
            .padding(.trailing, RowLine.cornerGutter)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
        .ditherCorner(disconnected ? .readyToMerge : signal, background: session.isWaitingOnJobs, monochrome: disconnected)
        .onHover { hovered = $0 }
        .onPreferenceChange(SessionRepositoryHelpKey.self) { repositoryHelp = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .help([draft?.help,
               [session.isDiagnosticsSpecialist ? "Diagnostics · Read-only" : nil,
                reason ?? signal?.label, missionTitle.map { "Mission: \($0)" }, session.trackedSource?.summary,
                session.cwd.abbreviatingHome]
                .compactMap { $0 }.joined(separator: " · "), RowLineSegments.pullRequestSummary(session), repositoryHelp]
            .compactMap { $0 }.joined(separator: "\n"))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel(described, state: reason == nil && coordinatorDetail == nil ? signal?.label : nil))
        .contextMenu {
            SessionProjectAction(session: session)
            SessionRenameAction(session: session)
            SessionClipboardActions(session: session)
            if session.canChangePin {
                Button {
                    model.setPinned(!session.isPinned, sessionId: owner?.storageKey ?? session.id)
                } label: {
                    Label(session.isPinned ? "Unpin" : "Pin", icon: session.isPinned ? PilotIcon.unpin : PilotIcon.pin)
                }
                .disabled(model.pendingSessionActions.contains(session.id))
                .help(session.isPinned ? "Return this chat to its usual list position and allow automatic archiving" :
                      "Keep this chat first and prevent automatic archiving")
            }
            SessionArchiveAction(session: session)
            Divider()
            SessionMissionActions(session: session)
            Divider()
            if session.canStop {
                Button("Stop Session") { model.stopSession(owner?.storageKey ?? session.id) }
            }
            ForEach(session.linkedPullRequests, id: \.url) { pr in
                if let url = pr.browserURL {
                    Link("Open PR #\(pr.number) in Browser", destination: url)
                        .help(session.pullRequestHelpText ?? "")
                }
            }
        }
    }

    /// The title, then the whole second line in words (every PR included), then the state when nothing else says it.
    private func accessibilityLabel(_ segments: [RowLineSegment], state: String?) -> String {
        var parts = [session.title]
        if !segments.isEmpty { parts.append(segments.accessibilityText) }
        if let state { parts.append(state) }
        return parts.joined(separator: ". ")
    }
}

/// Shown only while pilotd is unreachable.
private struct ConnectionFooter: View {
    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Theme.warning)
                .frame(width: 6, height: 6)
            Text("Connecting to pilotd…")
            Spacer()
        }
        .font(.pilot(.small))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

/// Appears on ⌘F. Escape clears it and hides it again.
private struct SearchField: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            PilotSymbol(PilotIcon.search).foregroundStyle(Theme.faintForeground)
            TextField("Search chats", text: $text)
                .textFieldStyle(.plain)
                .font(.pilot(.label))
                .focused(focused)
                .onExitCommand(perform: onDismiss)
            Button(action: onDismiss) {
                PilotSymbol(PilotIcon.clearField, context: .toolbar).foregroundStyle(Theme.faintForeground)
            }
            .buttonStyle(.plain)
            .help("Close search (Esc)")
            .accessibilityLabel("Close search")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border))
    }
}
