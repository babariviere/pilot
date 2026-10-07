import AppKit
import PilotCore
import SwiftUI

/// Sessions grouped by project and optional user-created folders, newest first.
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
            if let sessionId = model.selectedSessionId {
                SessionArtifactsSection(sessionId: sessionId, client: client).id(sessionId)
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
                } label: {
                    Image(systemName: "plus").frame(width: 28, height: 28)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Add a project or create a folder")
                .accessibilityLabel("Add a project or create a folder")
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
        return [session.title, session.branch ?? "", session.cwd, session.model ?? "",
                session.pullRequest?.label ?? "", session.pullRequest?.title ?? ""]
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
            Image(systemName: "folder").font(.system(size: 10))
            Text(project.name).font(.system(size: 11, weight: .semibold))
            if working > 0 {
                Text("\(working)")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                    .foregroundStyle(Color.accentColor)
            }
            Spacer()
            ProjectArtifactsButton(project: project, client: client)
            Button(action: onArchive) { Image(systemName: "archivebox") }
                .buttonStyle(.borderless)
                .help("Browse archived chats in \(project.name)")
            Button(action: onNew) { Image(systemName: "plus") }
                .buttonStyle(.borderless)
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
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            SessionStatusIcon(status: session.status)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .font(.system(size: 13, weight: model.isUnread(session) ? .semibold : .regular))
                    .lineLimit(1)
                SessionRepositoryMetadata(session: session)
            }
            Spacer(minLength: 4)
            if model.isUnread(session) { UnreadBadge() }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(SessionTimeFormatting.relative(session.updatedAt, now: context.date))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
        .padding(.vertical, 2)
        .help(session.cwd.abbreviatingHome)
        .contextMenu {
            SessionArchiveAction(session: session)
            if session.isWorking {
                Button("Stop Session") { model.stopSession(session.id) }
            }
            if let pr = session.pullRequest, let url = pr.browserURL {
                Link("Open PR #\(pr.number) in Browser", destination: url)
                    .help(session.pullRequestHelpText ?? "")
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
