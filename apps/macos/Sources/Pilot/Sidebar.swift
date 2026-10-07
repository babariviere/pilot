import AppKit
import PilotCore
import SwiftUI

/// Sessions grouped by project, newest first.
struct SessionSidebar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var client: PilotClient

    var body: some View {
        let known = Set(client.projects.map(\.id))
        let visible = client.activeSessions.filter(matches)
        let searching = !model.sidebarQuery.trimmingCharacters(in: .whitespaces).isEmpty
        let unassigned = visible.filter { $0.projectId.map { !known.contains($0) } ?? true }
        List(selection: $model.selectedSessionId) {
            ForEach(client.projects) { project in
                let sessions = visible.filter { $0.projectId == project.id }
                if !searching || !sessions.isEmpty {
                    let isExpanded = searching ? Binding.constant(true) : expanded(project.id)
                    // Native expandable sidebar sections insert a disclosure control on hover,
                    // shrinking the header and moving its action buttons underneath the pointer.
                    Section {
                        if isExpanded.wrappedValue {
                            ForEach(sessions) { SessionRow(session: $0).tag($0.id) }
                            if sessions.isEmpty {
                                Text("No sessions").font(.caption).foregroundStyle(Theme.faintForeground)
                            }
                        }
                    } header: {
                        ProjectHeader(project: project, client: client, working: sessions.filter(\.isWorking).count,
                                      isExpanded: isExpanded, onArchive: {
                            model.showArchive(in: project.id)
                        }) {
                            model.newSession(in: project.id)
                        }
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
            if client.projects.isEmpty, client.sessions.isEmpty {
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
                Button { model.addProject() } label: {
                    Image(systemName: "folder.badge.plus").frame(width: 28, height: 28)
                }
                .buttonStyle(.borderless)
                .help("Add Project… (⇧⌘O)")
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
        }
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
    let working: Int
    @Binding var isExpanded: Bool
    let onArchive: () -> Void
    let onNew: () -> Void

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
            Divider()
            Button("Remove Project", role: .destructive) {
                Task { try? await AppModel.shared.client.deleteProject(project.id) }
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
                PullRequestBadge(session: session)
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
