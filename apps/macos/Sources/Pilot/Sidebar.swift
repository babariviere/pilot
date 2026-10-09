import AppKit
import PilotCore
import SwiftUI

/// Sessions grouped by project and optional user-created folders, pinned first, then PR status and stable activity.
struct SessionSidebar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var client: PilotClient
    @StateObject private var folderEditor = ProjectFolderEditorState()

    var body: some View {
        let known = Set(client.projects.map(\.id))
        let visible = client.activeSessions.filter(matches)
        let searching = !model.sidebarQuery.trimmingCharacters(in: .whitespaces).isEmpty
        let unassigned = visible.filter { $0.projectId.map { !known.contains($0) } ?? true }
        List(selection: $model.selectedSessionId) {
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
                                projectHeader(project, sessions: sessions, isExpanded: isExpanded)
                                    .padding(.leading, 12)
                                    .selectionDisabled(true)
                                if isExpanded.wrappedValue {
                                    projectSessions(sessions, indented: true)
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
                            projectSessions(sessions)
                        }
                    } header: {
                        projectHeader(project, sessions: sessions, isExpanded: isExpanded)
                    }
                }
            }
            if !unassigned.isEmpty {
                Section(client.projects.isEmpty ? "Sessions" : "Other") {
                    ForEach(unassigned) { SessionRow(session: $0).tag($0.id) }
                }
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
            VStack(spacing: 6) {
            HStack(spacing: 6) {
                SidebarButton(title: "New session", icon: "square.and.pencil", selected: model.selectedSessionId == nil && !model.showingArchive) {
                    model.newSession(in: model.draftProjectId)
                }
                Menu {
                    Button("Add Project…") { model.addProject() }
                    Button("New Folder…") { folderEditor.begin() }
                    Button("New Mission…") { model.missionSheet = .create(projectId: nil) }
                        .disabled(client.projects.isEmpty)
                } label: {
                    Image(systemName: "plus").frame(width: 28, height: 28)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Add a project, or create a folder or mission")
                .accessibilityLabel("Add a project, or create a folder or mission")
            }
            SidebarButton(title: "Archived chats (\(client.archivedSessions.count))", icon: "archivebox",
                          selected: model.showingArchive && model.selectedSessionId == nil) {
                model.showArchive()
            }
            SearchField(text: $model.sidebarQuery)
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 6)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ConnectionFooter(client: client)
                // The list can draw beneath its safe-area inset while scrolling.
                // Keep session metadata from showing through the status text.
                .background(Theme.sidebar)
                .overlay(alignment: .top) {
                    Rectangle().fill(Theme.border).frame(height: 1)
                }
        }
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

    private func projectHeader(_ project: Project, sessions: [SessionSummary], isExpanded: Binding<Bool>) -> some View {
        ProjectHeader(project: project, client: client, model: model,
                      working: sessions.filter(\.isWorking).count, isExpanded: isExpanded,
                      onArchive: { model.showArchive(in: project.id) },
                      onNew: { model.newSession(in: project.id) },
                      onNewFolder: { folderEditor.begin(projectId: project.id) })
    }

    @ViewBuilder
    private func missionsSection(visible: [SessionSummary], searching: Bool) -> some View {
        let query = model.sidebarQuery.trimmingCharacters(in: .whitespaces).lowercased()
        let matching = client.missions.filter { mission in
            !searching || mission.title.lowercased().contains(query)
                || visible.contains { $0.missionId == mission.id }
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
                    Button { model.showingInactiveMissions.toggle() } label: {
                        HStack(spacing: 6) {
                            Image(systemName: showing ? "chevron.down" : "chevron.right")
                                .font(.system(size: 9, weight: .semibold)).frame(width: 14)
                            Text("Done and archived (\(inactive.count))").font(.caption)
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(Theme.mutedForeground)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .selectionDisabled(true)
                    if showing {
                        ForEach(inactive) { mission in
                            missionRows(mission, visible: visible, searching: searching)
                        }
                    }
                }
            } header: {
                HStack(spacing: 6) {
                    Image(systemName: "scope").font(.system(size: 10)).frame(width: 14)
                    Text("Missions").font(.system(size: 11, weight: .semibold))
                    Spacer(minLength: 0)
                    Button { model.missionSheet = .create(projectId: nil) } label: { Image(systemName: "plus") }
                        .buttonStyle(.borderless)
                        .frame(width: 16, height: 16)
                        .help("New mission…")
                        .accessibilityLabel("New mission")
                }
                .contextMenu {
                    Button("New Mission…") { model.missionSheet = .create(projectId: nil) }
                }
            }
        }
    }

    @ViewBuilder
    private func missionRows(_ mission: Mission, visible: [SessionSummary], searching: Bool) -> some View {
        let members = MissionMembers.members(of: mission, in: visible)
        let isExpanded = searching ? Binding.constant(true) : missionExpanded(mission.id)
        MissionSidebarRow(mission: mission, needsYou: model.needsYou(mission).count,
                          chatCount: members.count, working: members.filter(\.isWorking).count,
                          selected: model.selectedMissionId == mission.id && model.selectedSessionId == nil,
                          isExpanded: isExpanded)
            .selectionDisabled(true)
        if isExpanded.wrappedValue {
            ForEach(members) { session in
                SessionRow(session: session, showsMission: false)
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
    private func projectSessions(_ sessions: [SessionSummary], indented: Bool = false) -> some View {
        ForEach(sessions) { session in
            SessionRow(session: session).padding(.leading, indented ? 20 : 0).tag(session.id)
        }
        if sessions.isEmpty {
            Text("No sessions").font(.caption).foregroundStyle(Theme.faintForeground)
                .padding(.leading, indented ? 20 : 0)
                .selectionDisabled(true)
        }
    }

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

private struct SidebarButton: View {
    let title: String
    let icon: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Theme.subtleFill : Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct ProjectHeader: View {
    let project: Project
    @ObservedObject var client: PilotClient
    @ObservedObject var model: AppModel
    let working: Int
    @Binding var isExpanded: Bool
    let onArchive: () -> Void
    let onNew: () -> Void
    let onNewFolder: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button { isExpanded.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "folder").font(.system(size: 10)).frame(width: 14)
                    Text(project.name)
                        .font(.system(size: 11, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if working > 0 {
                        Text("\(working)")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                            .foregroundStyle(Color.accentColor)
                            .fixedSize()
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(isExpanded ? "Collapse" : "Expand") \(project.name)")
            ProjectArtifactsButton(project: project, client: client)
                .frame(width: 16, height: 16)
            Button(action: onArchive) { Image(systemName: "archivebox") }
                .buttonStyle(.borderless)
                .frame(width: 16, height: 16)
                .help("Browse archived chats in \(project.name)")
            Button(action: onNew) { Image(systemName: "plus") }
                .buttonStyle(.borderless)
                .frame(width: 16, height: 16)
                .help("New session in \(project.name)")
            Button { isExpanded.toggle() } label: {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 16, height: 16)
            }
            .buttonStyle(.borderless)
            .help("\(isExpanded ? "Collapse" : "Expand") \(project.name)")
            .accessibilityLabel("\(isExpanded ? "Collapse" : "Expand") \(project.name)")
        }
        .contextMenu {
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

struct SessionRow: View {
    let session: SessionSummary
    /// Off under the mission's own sidebar entry, where the mark would repeat.
    var showsMission = true
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                SessionStatusIcon(status: session.status)
                Text(session.title)
                    .font(.system(size: 13, weight: model.isUnread(session) ? .semibold : .regular))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if model.isUnread(session) { UnreadBadge() }
                if showsMission, session.missionId != nil {
                    Image(systemName: "scope")
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
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                        .fixedSize()
                }
            }
            SessionRepositoryMetadata(session: session)
                // Match the title's inset (14-point status column plus 8-point spacing).
                .padding(.leading, 22)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
        .help(session.cwd.abbreviatingHome)
        .contextMenu {
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
            if model.isUnread(session) {
                Button("Mark as reviewed") { model.review(session, explicit: true) }
            }
        }
    }
}

private struct ConnectionFooter: View {
    @ObservedObject var client: PilotClient

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(client.connected ? Color.green : Color.orange)
                .frame(width: 6, height: 6)
            Text(client.connected ? "pilotd connected" : "Connecting to pilotd…")
            Spacer()
            if client.workingCount > 0 {
                Text("\(client.workingCount) working")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

private struct SearchField: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(Theme.faintForeground)
            TextField("Search sessions", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 11)).foregroundStyle(Theme.faintForeground)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.border))
    }
}
