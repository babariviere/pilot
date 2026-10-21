import PilotCore
import SwiftUI

/// Archived chats in the reading column: project and mission chips, search in the toolbar, and one-line rows that
/// open the chat, with Restore under the pointer, in the context menu and on keyboard focus. Archives remain in the
/// client's WebSocket inventory, but never in normal chat lists.
struct ArchiveView: View {
    @Environment(\.hostViewContext) private var hostContext
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client
    @StateObject private var browser = ArchiveBrowserState()
    @StateObject private var keyboardRows = KeyboardListState()

    private var sessions: [SessionSummary] {
        let query = browser.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let inventory = browser.sessions.filter {
            !RetainedConversation.isHistory($0, reference: hostContext?.ref(.session, $0.id), localHost: model.localHost)
        }
        if query.isEmpty { return inventory }
        return inventory.filter { session in
            [session.title, session.cwd, session.branch ?? "", client.project(session.projectId)?.name ?? ""]
                .contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    var body: some View {
        let shown = sessions
        VStack(alignment: .leading, spacing: 12) {
            PageHeader("Archived chats", subtitle: "History and workspaces are kept. Restore a chat to send messages again.")
                .padding(.horizontal, 8)
            ArchiveFilterBar(shown: browser.loading || browser.error != nil ? nil : shown.count)
            HairlineDivider()
            content(shown)
        }
        .padding(.horizontal, 24)
        .padding(.top, 24)
        .frame(maxWidth: Theme.column, maxHeight: .infinity, alignment: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .navigationTitle("Archived chats")
        .searchable(text: $browser.query, placement: .toolbar, prompt: "Search archived chats")
        .task(id: Request(filter: model.archiveFilter, connected: client.connected, revision: browser.reloadRevision)) {
            let filter = model.archiveFilter
            await browser.load(filter) { try await client.archivedSessions(filter: filter) }
        }
        .onChange(of: client.sessions) { _, inventory in
            browser.receive(inventory, filter: model.archiveFilter)
        }
        .onChange(of: client.missions) { _, missions in
            if let id = model.archiveMissionId, !missions.contains(where: { $0.id == id }) {
                model.chooseArchiveMission(nil)
            }
        }
    }

    private struct Request: Hashable {
        let filter: ArchiveFilter
        let connected: Bool
        let revision: Int
    }

    @ViewBuilder private func content(_ shown: [SessionSummary]) -> some View {
        if browser.loading {
            ProgressView("Loading archived chats…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = browser.error {
            EmptyStateView(icon: PilotIcon.warning, title: "Couldn't load archived chats", message: error) {
                Button("Retry") { browser.reloadRevision += 1 }
            }
            .frame(maxHeight: .infinity)
        } else if shown.isEmpty {
            let filtered = !browser.query.isEmpty || model.archiveProjectId != nil || model.archiveMissionId != nil
            EmptyStateView(icon: PilotIcon.archive,
                           title: filtered ? "No matching archived chats" : "No archived chats",
                           message: filtered
                               ? "Try another search, project or mission."
                               : "Chats you archive appear here, with their history.")
                .frame(maxHeight: .infinity)
        } else {
            // List keeps long archives virtualised. Relative times refresh once a minute.
            TimelineView(.periodic(from: .now, by: 60)) { context in
                List(shown) { session in
                    ArchiveRow(session: session, projectName: client.project(session.projectId)?.name,
                               now: context.date)
                        .keyboardListItem(session.id, target: .session(id: session.id,
                                                                       reference: hostContext?.ref(.session, session.id))) {
                            model.navigate(.session, id: session.id, context: hostContext)
                        }
                        .listRowInsets(EdgeInsets(top: 1, leading: 0, bottom: 1, trailing: 0))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .keyboardList(state: keyboardRows, native: true)
                .onChange(of: shown.map(\.id), initial: true) { _, _ in
                    keyboardRows.update(shown.map { session in
                        KeyboardListItem(id: session.id, target: .session(id: session.id,
                                                                          reference: hostContext?.ref(.session, session.id))) {
                            model.navigate(.session, id: session.id, context: hostContext)
                        }
                    })
                }
            }
        }
    }
}

/// Project and mission chips, as in Slack triage's filter bar, then how many chats are shown.
private struct ArchiveFilterBar: View {
    /// Shown chats, or nil while loading or failed.
    let shown: Int?
    @EnvironmentObject private var model: AppModel
    @EndpointClient private var client

    var body: some View {
        let missions = client.missions.filter { model.archiveProjectId == nil || $0.projectId == model.archiveProjectId }
        let mission = model.archiveMissionId.flatMap { id in client.missions.first { $0.id == id } }
        HStack(spacing: 8) {
            Menu {
                Picker("Project", selection: Binding(get: { model.archiveProjectId },
                                                     set: { model.chooseArchiveProject($0) })) {
                    Text("All projects").tag(String?.none)
                    if !model.orderedProjects.isEmpty { Divider() }
                    ForEach(model.orderedProjects) { project in
                        Text(project.name).tag(String?.some(project.id))
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                ChipLabel(title: client.project(model.archiveProjectId)?.name ?? "All projects", icon: PilotIcon.project,
                          maxTitleWidth: 180)
            }
            .chipMenuStyle().fixedSize()
            .help("Show archived chats from every project or from one")
            .accessibilityLabel("Project filter, \(client.project(model.archiveProjectId)?.name ?? "all projects")")
            if !missions.isEmpty || mission != nil {
                Menu {
                    Picker("Mission", selection: Binding(get: { model.archiveMissionId },
                                                         set: { model.chooseArchiveMission($0) })) {
                        Text("All missions").tag(String?.none)
                        if !missions.isEmpty { Divider() }
                        ForEach(missions) { mission in
                            Text(model.archiveProjectId == nil
                                 ? "\(mission.title) · \(client.project(mission.projectId)?.name ?? "Unknown project")"
                                 : mission.title).tag(String?.some(mission.id))
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } label: {
                    ChipLabel(title: mission?.title ?? "All missions", icon: PilotIcon.mission, maxTitleWidth: 200)
                }
                .chipMenuStyle().fixedSize()
                .help("Show archived chats from every mission or from one")
                .accessibilityLabel("Mission filter, \(mission?.title ?? "all missions")")
            }
            Spacer(minLength: 8)
            if let shown {
                MetaText("\(shown) \(shown == 1 ? "chat" : "chats")")
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 8)
    }
}

/// One archived chat on one line: its title, then "pilot · archived 3d ago". Clicking reads the chat; Restore shows
/// under the pointer or keyboard focus and stays in the context menu.
private struct ArchiveRow: View {
    @Environment(\.hostViewContext) private var hostContext
    let session: SessionSummary
    let projectName: String?
    let now: Date
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HoverRow { hovered in
            HStack(spacing: 12) {
                Button { model.navigate(.session, id: session.id, context: hostContext) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(session.title)
                            .font(.pilot(.body))
                            .foregroundStyle(Theme.foreground)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .layoutPriority(1)
                        RemoteChatBadge()
                        Text(meta)
                            .font(.pilot(.caption))
                            .foregroundStyle(Theme.mutedForeground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .rowButtonStyle()
                .help(readHelp)
                .accessibilityLabel([session.title, RemoteChatBadgeText(context: hostContext)?.accessibilityLabel, meta].compactMap { $0 }.joined(separator: ", "))
                .accessibilityHint("Reads the archived chat")
                SessionArchiveAction(session: session)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .revealed(hovered)
            }
        }
        .contextMenu {
            Button("Read Chat") { model.navigate(.session, id: session.id, context: hostContext) }
            SessionProjectAction(session: session)
            SessionRenameAction(session: session)
            SessionClipboardActions(session: session)
            SessionArchiveAction(session: session)
        }
        .accessibilityAction(named: "Restore") { model.setArchived(false, sessionId: hostContext?.ref(.session, session.id).storageKey ?? session.id) }
    }

    /// "pilot · archived 3d ago", or the folder for chats outside a project.
    private var meta: String {
        let place = projectName ?? session.cwd.abbreviatingHome
        guard let archivedAt = session.archivedAt else { return place }
        return "\(place) · archived \(RelativeDate.ago(archivedAt, now: now))"
    }

    private var readHelp: String {
        guard let archivedAt = session.archivedAt else { return "Read archived chat" }
        return "Read archived chat. Archived \(RelativeDate.exact(archivedAt))."
    }
}

/// Used in the toolbar, chat context menu, archive browser, and archived composer.
struct SessionArchiveAction: View {
    @Environment(\.hostViewContext) private var hostContext
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        // Retired Control history cannot be restored as an agent.
        if !session.isRetainedHistory { button }
    }

    private var button: some View {
        let pending = model.pendingSessionActions.contains(session.id)
        return Button {
            model.setArchived(!session.isArchived, sessionId: hostContext?.ref(.session, session.id).storageKey ?? session.id)
        } label: {
            Label(title(pending: pending), icon: session.isArchived ? PilotIcon.restore : PilotIcon.archive)
        }
        .disabled(pending || (!session.isArchived && !session.canArchive))
        .help(session.isArchived ? "Restore this chat to send messages again" :
              session.isWorking ? "Stop the chat before archiving it" : "Archive chat. History and workspace are kept.")
    }

    private func title(pending: Bool) -> String {
        if pending { return session.isArchived ? "Restoring…" : "Archiving…" }
        if session.isArchived { return "Restore" }
        return session.isWorking ? "Archive (Stop first)" : "Archive"
    }
}

/// No editor or send shortcut is mounted while archived; the transcript stays subscribed.
struct ArchivedComposer: View {
    let session: SessionSummary

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Archived chat · Read-only", icon: PilotIcon.archive)
                    .font(.pilot(.body, weight: .medium))
                Text("Restore to send messages. History and workspace are kept.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
            Spacer()
            SessionArchiveAction(session: session)
                .buttonStyle(.bordered)
        }
        .padding(14)
        .card(radius: Theme.Radius.tray)
        .frame(maxWidth: Theme.column)
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
    }
}
