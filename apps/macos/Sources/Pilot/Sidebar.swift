import AppKit
import PilotCore
import SwiftUI

/// Sessions by urgency (Needs you, Working, Recent) or by project and optional user-created folders, pinned first,
/// then PR status and stable activity. The scope switcher at the top lists every project (the default) or focuses on
/// one, which then shows only that project's missions and chats. Search appears on ⌘F, and the footer only when
/// the connection to pilotd needs attention. Each chat's state is its dithered corner (`DitherCorner`).
struct SessionSidebar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var client: PilotClient
    @StateObject private var folderEditor = ProjectFolderEditorState()

    @FocusState private var searchFocused: Bool

    var body: some View {
        let known = Set(client.projects.map(\.id))
        let visible = client.activeSessions.filter(matches)
        let searching = !model.sidebarQuery.trimmingCharacters(in: .whitespaces).isEmpty
        let unassigned = visible.filter { $0.projectId.map { !known.contains($0) } ?? true }
        let counts = client.projectCounts.projects
        let focused = model.focusedProject
        let showsSearch = model.sidebarSearchVisible || searching
        List(selection: $model.selectedSessionId) {
            if let focused {
                focusedContent(focused, visible: visible, searching: searching)
            } else if model.sidebarGroupsByUrgency {
                urgencyContent(visible: visible, searching: searching)
            } else {
                allProjectsContent(visible: visible, searching: searching, unassigned: unassigned, counts: counts)
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Theme.sidebar)
        .overlay {
            if client.projects.isEmpty, client.sessions.isEmpty, model.projectFolders.folders.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "folder.badge.plus").font(.title2).foregroundStyle(.secondary)
                    Text("Add a project to get started").font(.callout).foregroundStyle(.secondary)
                    Button("Add Project…") { model.addProject() }
                }
                .padding()
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            // One row: scope, Home, Inbox and compose. Archived chats live in the scope menu, search behind ⌘F.
            let scopeCount = focused.map { counts[$0.id] ?? ProjectDashboardCount() }
                ?? SidebarScopeCounts.total(counts)
            let archived = focused.map { project in
                client.archivedSessions.filter { $0.projectId == project.id }.count
            } ?? client.archivedSessions.count
            VStack(spacing: 6) {
                SidebarScopeSwitcher(model: model, client: client, counts: counts, needsYou: scopeCount.needsYou,
                                     homeSelected: homeSelected(focused), inboxCount: InboxText.badge(scopeCount),
                                     inboxSelected: inboxSelected, archivedCount: archived,
                                     onNewFolder: { folderEditor.begin() })
                if showsSearch {
                    SearchField(text: $model.sidebarQuery, focused: $searchFocused) { model.hideSidebarSearch() }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 6)
            .animation(Theme.Motion.quick, value: showsSearch)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // Quiet while connected. Working counts live in the rows' corners.
            VStack(spacing: 0) {
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
        .onAppear { model.validateSidebarScope() }
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

    /// Home is selected when the detail shows it: today's Home, or the focused project's page.
    private func homeSelected(_ focused: Project?) -> Bool {
        guard model.selectedSessionId == nil else { return false }
        if let focused { return model.selectedProjectId == focused.id }
        return model.selectedMissionId == nil && model.selectedProjectId == nil && !model.showingArchive
            && !model.showingInbox
    }

    private var inboxSelected: Bool {
        model.showingInbox && model.selectedSessionId == nil && model.selectedMissionId == nil
            && model.selectedProjectId == nil
    }

    /// Focused on one project: its missions, then its chats, without project headers.
    @ViewBuilder
    private func focusedContent(_ project: Project, visible: [SessionSummary], searching: Bool) -> some View {
        missionsSection(visible: visible, searching: searching, projectId: project.id)
        let sessions = visible.filter { $0.projectId == project.id }
        if !searching || !sessions.isEmpty {
            Section("Chats") {
                projectSessions(sessions, listId: project.id, searching: searching)
            }
        }
    }

    /// Every project's chats by urgency, each row naming its project. Folders and project headers stay out of the way;
    /// the scope switcher and project pages reach them.
    @ViewBuilder
    private func urgencyContent(visible: [SessionSummary], searching: Bool) -> some View {
        missionsSection(visible: visible, searching: searching)
        let groups = SidebarUrgency.groups(visible) { model.isUnread($0) }
        let names = Dictionary(client.projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        if !groups.needsYou.isEmpty {
            Section {
                ForEach(groups.needsYou) { session in
                    SessionRow(session: session, projectName: projectName(session, names)).tag(session.id)
                }
            } header: {
                SidebarSectionHeader(title: "Needs you", count: groups.needsYou.count, attention: true)
            }
        }
        if !groups.working.isEmpty {
            Section {
                ForEach(groups.working) { session in
                    SessionRow(session: session, projectName: projectName(session, names)).tag(session.id)
                }
            } header: {
                SidebarSectionHeader(title: "Working", count: groups.working.count)
            }
        }
        if !groups.recent.isEmpty {
            Section {
                projectSessions(groups.recent, listId: Self.recentListId, searching: searching, projectNames: names)
            } header: {
                SidebarSectionHeader(title: "Recent")
            }
        }
        if groups.isEmpty, !client.projects.isEmpty {
            Text(searching ? "No matching chats" : "No chats yet")
                .font(.caption).foregroundStyle(Theme.faintForeground)
                .selectionDisabled(true)
        }
    }

    private func projectName(_ session: SessionSummary, _ names: [String: String]?) -> String? {
        guard let names, let id = session.projectId else { return nil }
        return names[id]
    }

    /// Every project, grouped by folder, then chats outside any known project.
    @ViewBuilder
    private func allProjectsContent(visible: [SessionSummary], searching: Bool, unassigned: [SessionSummary],
                                    counts: [String: ProjectDashboardCount]) -> some View {
        missionsSection(visible: visible, searching: searching)
        ForEach(model.projectFolders.folders) { folder in
            let projects = client.projects.filter { model.projectFolders.folderId(for: $0.id) == folder.id }
            let matching = projects.filter { project in visible.contains { $0.projectId == project.id } }
            if !searching || !matching.isEmpty {
                Section {
                    if searching || !model.projectFolders.collapsed.contains(folder.id) {
                        ForEach(searching ? matching : projects) { project in
                            let sessions = visible.filter { $0.projectId == project.id }
                            let isExpanded = searching ? Binding.constant(true) : expanded(project.id)
                            projectHeader(project, needsYou: counts[project.id]?.needsYou ?? 0, sessions: sessions,
                                          isExpanded: isExpanded)
                                .padding(.leading, 12)
                                .selectionDisabled(true)
                            if isExpanded.wrappedValue {
                                projectSessions(sessions, listId: project.id, searching: searching, indented: true)
                            }
                        }
                        if projects.isEmpty {
                            Text("Move projects here using their context menu")
                                .font(.caption).foregroundStyle(Theme.faintForeground)
                                .padding(.leading, 12)
                                .selectionDisabled(true)
                        }
                    }
                } header: {
                    ProjectFolderHeader(folder: folder, count: projects.count,
                                        isExpanded: searching ? .constant(true) : folderExpanded(folder.id),
                                        onRename: { folderEditor.begin(folder) },
                                        onDelete: { model.projectFolders.remove(folder.id) })
                }
            }
        }
        ForEach(client.projects.filter { model.projectFolders.folderId(for: $0.id) == nil }) { project in
            let sessions = visible.filter { $0.projectId == project.id }
            if !searching || !sessions.isEmpty {
                let isExpanded = searching ? Binding.constant(true) : expanded(project.id)
                // Custom disclosure buttons keep header actions from shifting on hover.
                Section {
                    if isExpanded.wrappedValue {
                        projectSessions(sessions, listId: project.id, searching: searching)
                    }
                } header: {
                    projectHeader(project, needsYou: counts[project.id]?.needsYou ?? 0, sessions: sessions,
                                  isExpanded: isExpanded)
                }
            }
        }
        if !unassigned.isEmpty {
            Section(client.projects.isEmpty ? "Sessions" : "Other") {
                projectSessions(unassigned, listId: Self.otherListId, searching: searching)
            }
        }
    }

    private func projectHeader(_ project: Project, needsYou: Int, sessions: [SessionSummary],
                               isExpanded: Binding<Bool>) -> some View {
        ProjectHeader(project: project, client: client, model: model, needsYou: needsYou, isExpanded: isExpanded,
                      onArchive: { model.showArchive(in: project.id) },
                      onNew: { model.newSession(in: project.id) },
                      onNewFolder: { folderEditor.begin(projectId: project.id) })
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
                    missionRows(mission, visible: visible, searching: searching)
                }
                if active.isEmpty, !searching {
                    Text("No active missions").font(.caption).foregroundStyle(Theme.faintForeground)
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
                            missionRows(mission, visible: visible, searching: searching)
                        }
                    }
                }
            } header: {
                HStack(spacing: 6) {
                    Image(systemName: MissionSymbol.name).font(.system(size: 10)).frame(width: 14)
                    Text("Missions").font(.system(size: 11, weight: .semibold))
                    Spacer(minLength: 0)
                    Button { model.missionSheet = .create(projectId: projectId) } label: { Image(systemName: "plus") }
                        .buttonStyle(.borderless)
                        .frame(width: 16, height: 16)
                        .help("New mission…")
                        .accessibilityLabel("New mission")
                }
                .contextMenu {
                    Button("New Mission…") { model.missionSheet = .create(projectId: projectId) }
                }
            }
        }
    }

    @ViewBuilder
    private func missionRows(_ mission: Mission, visible: [SessionSummary], searching: Bool) -> some View {
        let members = MissionMembers.members(of: mission, in: visible)
        let isExpanded = searching ? Binding.constant(true) : missionExpanded(mission.id)
        MissionSidebarRow(mission: mission, needsYou: model.needsYouCount(mission),
                          chatCount: members.count, working: members.filter(\.isWorking).count,
                          selected: model.selectedMissionId == mission.id && model.selectedSessionId == nil,
                          isExpanded: isExpanded)
            .selectionDisabled(true)
        if isExpanded.wrappedValue {
            ForEach(members) { session in
                SessionRow(session: session, showsMission: false,
                           isCoordinator: mission.coordinatorSessionId == session.id)
                    .padding(.leading, 20)
                    .tag(session.id)
            }
            if members.isEmpty {
                Text("No chats").font(.caption).foregroundStyle(Theme.faintForeground)
                    .padding(.leading, 20)
                    .selectionDisabled(true)
            }
        }
    }

    private func missionExpanded(_ id: String) -> Binding<Bool> {
        Binding(
            get: { model.expandedMissions.contains(id) },
            set: { open in
                if open { model.expandedMissions.insert(id) } else { model.expandedMissions.remove(id) }
            }
        )
    }

    @ViewBuilder
    private func projectSessions(_ sessions: [SessionSummary], listId: String, searching: Bool,
                                 indented: Bool = false, projectNames: [String: String]? = nil) -> some View {
        let showingAll = searching || model.expandedSessionLists.contains(listId)
        let collapsed = SidebarSessionList.collapsed(sessions) { session in
            session.id == model.selectedSessionId || session.isReadyToMerge || model.isUnread(session)
        }
        let list = showingAll ? (shown: sessions, hidden: 0) : collapsed
        ForEach(list.shown) { session in
            SessionRow(session: session, projectName: projectName(session, projectNames))
                .padding(.leading, indented ? 20 : 0).tag(session.id)
        }
        if sessions.isEmpty {
            Text("No sessions").font(.caption).foregroundStyle(Theme.faintForeground)
                .padding(.leading, indented ? 20 : 0)
                .selectionDisabled(true)
        }
        if list.hidden > 0 {
            SidebarDisclosureRow(title: "\(list.hidden) quiet \(list.hidden == 1 ? "chat" : "chats")", expanded: false) {
                model.expandedSessionLists.insert(listId)
            }
            .padding(.leading, indented ? 20 : 0)
            .selectionDisabled(true)
        } else if !searching, showingAll, collapsed.hidden > 0 {
            SidebarDisclosureRow(title: "Show less", expanded: true) {
                model.expandedSessionLists.remove(listId)
            }
            .padding(.leading, indented ? 20 : 0)
            .selectionDisabled(true)
        }
    }

    static let otherListId = "pilot.sidebar.other"
    /// The Recent section when All projects groups chats by urgency.
    static let recentListId = "pilot.sidebar.recent"

    private func folderExpanded(_ id: String) -> Binding<Bool> {
        Binding(
            get: { !model.projectFolders.collapsed.contains(id) },
            set: { model.projectFolders.setExpanded($0, folderId: id) }
        )
    }

    private func matches(_ session: SessionSummary) -> Bool {
        let query = model.sidebarQuery.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return true }
        return ([session.title, session.branch ?? "", session.cwd, session.model ?? ""]
                + session.linkedPullRequests.flatMap { [$0.label, $0.title, $0.branch ?? ""] })
            .contains { $0.lowercased().contains(query) }
    }

    private func expanded(_ id: String) -> Binding<Bool> {
        Binding(
            get: { !model.collapsedProjects.contains(id) },
            set: { open in
                if open { model.collapsedProjects.remove(id) } else { model.collapsedProjects.insert(id) }
            }
        )
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
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold)).frame(width: 14)
                Text(title).font(.caption)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.mutedForeground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
            Text(title).font(.system(size: 11, weight: .semibold))
            if let count, count > 0 {
                CountBadge(count: count, style: attention ? .attention : .neutral)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ProjectHeader: View {
    let project: Project
    @ObservedObject var client: PilotClient
    @ObservedObject var model: AppModel
    let needsYou: Int
    @Binding var isExpanded: Bool
    let onArchive: () -> Void
    let onNew: () -> Void
    let onNewFolder: () -> Void
    @State private var hovered = false

    var body: some View {
        let selected = model.selectedProjectId == project.id && model.selectedSessionId == nil
        HStack(spacing: 6) {
            // The name opens the project page without changing the sidebar; the chevron folds its chats.
            Button { model.openProject(project.id) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "folder").font(.system(size: 10)).frame(width: 14)
                    Text(project.name)
                        .font(.system(size: 11, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .foregroundStyle(selected ? Theme.foreground : Color.secondary)
                    if needsYou > 0 {
                        CountBadge(count: needsYou, style: .attention)
                            .help("\(needsYou) \(needsYou == 1 ? "needs" : "need") you")
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(project.name)")
            .accessibilityAddTraits(selected ? .isSelected : [])
            .help("Open \(project.name) (\(project.path.abbreviatingHome))")
            // A resting header is just its name. Actions appear under the pointer and stay in the context menu.
            Group {
                ProjectArtifactsButton(project: project, client: client)
                    .frame(width: 16, height: 16)
                Button(action: onArchive) { Image(systemName: "archivebox") }
                    .buttonStyle(.borderless)
                    .frame(width: 16, height: 16)
                    .help("Browse archived chats in \(project.name)")
                    .accessibilityLabel("Browse archived chats in \(project.name)")
                Button(action: onNew) { Image(systemName: "plus") }
                    .buttonStyle(.borderless)
                    .frame(width: 16, height: 16)
                    .help("New session in \(project.name)")
                    .accessibilityLabel("New session in \(project.name)")
            }
            .revealed(hovered)
            Button { isExpanded.toggle() } label: {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    // Faint at rest, never hidden: SwiftUI does not hit-test fully transparent views, and the
                    // chevron must stay clickable before hover tracking catches up. A folded project shows it fully.
                    .foregroundStyle(hovered || !isExpanded ? Theme.mutedForeground : Theme.faintForeground.opacity(0.6))
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .help("\(isExpanded ? "Collapse" : "Expand") \(project.name)")
            .accessibilityLabel("\(isExpanded ? "Collapse" : "Expand") \(project.name)")
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Theme.subtleFill : Color.clear))
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .contextMenu {
            Button("Open Project") { model.openProject(project.id) }
            Button("Focus on This Project") { model.focus(on: project.id) }
            Button("New Session", action: onNew)
            Button("New Mission…") { model.missionSheet = .create(projectId: project.id) }
            Button("Browse Archived Chats", action: onArchive)
            Button("Open in Finder") { NSWorkspace.shared.open(URL(filePath: project.path)) }
            Menu("Move to Folder") {
                Button {
                    model.projectFolders.move(projectId: project.id, to: nil)
                } label: {
                    if model.projectFolders.folderId(for: project.id) == nil {
                        Label("Ungrouped", systemImage: "checkmark")
                    } else {
                        Text("Ungrouped")
                    }
                }
                ForEach(model.projectFolders.folders) { folder in
                    Button {
                        model.projectFolders.move(projectId: project.id, to: folder.id)
                    } label: {
                        if model.projectFolders.folderId(for: project.id) == folder.id {
                            Label(folder.name, systemImage: "checkmark")
                        } else {
                            Text(folder.name)
                        }
                    }
                }
                Divider()
                Button("New Folder…", action: onNewFolder)
            }
            Divider()
            Button("Remove Project", role: .destructive) {
                Task {
                    do {
                        try await client.deleteProject(project.id)
                        model.projectFolders.move(projectId: project.id, to: nil)
                    } catch {
                        model.sessionActionError = error.localizedDescription
                    }
                }
            }
        }
        .help(project.path.abbreviatingHome)
    }
}

/// One chat: its title, and its project (when the list is not grouped by project) and repository metadata.
/// The dithered corner carries its state, so the row needs no status column. Time, pin and mission marks show
/// under the pointer, in space the row always reserves, so hovering never reflows the title.
struct SessionRow: View {
    let session: SessionSummary
    /// Off under the mission's own sidebar entry, where the mark would repeat.
    var showsMission = true
    var isCoordinator = false
    /// Shown before the repository metadata in lists that mix projects.
    var projectName: String?
    @EnvironmentObject private var model: AppModel
    @State private var hovered = false

    var body: some View {
        let unread = model.isUnread(session)
        let signal = session.signal(unread: unread)
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(session.title)
                    .font(.system(size: 13, weight: unread ? .semibold : .regular))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isCoordinator || session.isActiveMissionCoordinator {
                    MissionCoordinatorIndicator()
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if showsMission, session.missionId != nil {
                        Image(systemName: MissionSymbol.name)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .help("In mission: \(model.client.mission(session.missionId)?.title ?? "")")
                            .accessibilityLabel("Mission chat")
                    }
                    if session.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .help("Pinned chat. Automatic archiving is disabled until unpinned.")
                            .accessibilityLabel("Pinned chat")
                    }
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(SessionTimeFormatting.relative(session.listActivityAt, now: context.date))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .fixedSize()
                    }
                }
                .revealed(hovered)
            }
            HStack(spacing: 4) {
                if let projectName {
                    Text(projectName)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Theme.mutedForeground)
                        .lineLimit(1)
                        .layoutPriority(1)
                    Text("·").font(.system(size: 10)).foregroundStyle(Theme.faintForeground)
                }
                SessionRepositoryMetadata(session: session)
            }
            // Stop short of the corner's densest cells.
            .padding(.trailing, 20)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
        .ditherCorner(signal)
        .onHover { hovered = $0 }
        .animation(Theme.Motion.quick, value: hovered)
        .help([signal?.label, session.cwd.abbreviatingHome].compactMap { $0 }.joined(separator: " · "))
        .contextMenu {
            SessionRenameAction(session: session)
            Button {
                model.setPinned(!session.isPinned, sessionId: session.id)
            } label: {
                Label(session.isPinned ? "Unpin" : "Pin", systemImage: session.isPinned ? "pin.slash" : "pin")
            }
            .disabled(model.pendingSessionActions.contains(session.id))
            .help(session.isPinned ? "Return this chat to its usual list position and allow automatic archiving" :
                  "Keep this chat first and prevent automatic archiving")
            SessionArchiveAction(session: session)
            Divider()
            SessionMissionActions(session: session)
            Divider()
            if session.isWorking {
                Button("Stop Session") { model.stopSession(session.id) }
            }
            ForEach(session.linkedPullRequests, id: \.url) { pr in
                if let url = pr.browserURL {
                    Link("Open PR #\(pr.number) in Browser", destination: url)
                        .help(session.pullRequestHelpText ?? "")
                }
            }
            if unread {
                Button("Mark as reviewed") { model.review(session, explicit: true) }
            }
        }
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
        .font(.caption)
        .foregroundStyle(.secondary)
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
            Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(Theme.faintForeground)
            TextField("Search chats", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused(focused)
                .onExitCommand(perform: onDismiss)
            Button(action: onDismiss) {
                Image(systemName: "xmark.circle.fill").font(.system(size: 11)).foregroundStyle(Theme.faintForeground)
            }
            .buttonStyle(.plain)
            .help("Close search (Esc)")
            .accessibilityLabel("Close search")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.border))
    }
}
