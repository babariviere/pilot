import PilotCore
import SwiftUI

/// Archives remain in the client's WebSocket inventory, but never in normal session lists.
struct ArchiveView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var browser = ArchiveBrowserState()

    private var sessions: [SessionSummary] {
        let query = browser.query.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty { return browser.sessions }
        return browser.sessions.filter { session in
            [session.title, session.cwd, session.branch ?? "", client.project(session.projectId)?.name ?? ""]
                .contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label("Archived chats", icon: PilotIcon.archive)
                    .font(.title2.weight(.semibold))
                Spacer()
            }
            ResponsiveControlsLayout(horizontalSpacing: 16, verticalSpacing: 8) { filters }
            Text("History and workspaces are kept. Restore a chat to send messages again.")
                .font(.callout)
                .foregroundStyle(Theme.mutedForeground)
            TextField("Search archived chats", text: $browser.query)
                .textFieldStyle(.roundedBorder)
            if browser.loading {
                ProgressView("Loading archived chats…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = browser.error {
                VStack(spacing: 8) {
                    Text("Could not load archived chats").font(.headline)
                    Text(error).foregroundStyle(Theme.mutedForeground).textSelection(.enabled)
                    Button("Retry") { browser.reloadRevision += 1 }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if sessions.isEmpty {
                VStack(spacing: 8) {
                    PilotSymbol(PilotIcon.archive, context: .emptyState)
                    Text(browser.query.isEmpty ? "No archived chats" : "No matching archived chats")
                }
                .foregroundStyle(Theme.mutedForeground)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                archiveList
            }
        }
        .padding(24)
        .background(Theme.background)
        .navigationTitle("Archived chats")
        .toolbar {
            Button("Home") { model.newSession(in: nil) }
        }
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

    @ViewBuilder private var filters: some View {
        Picker("Project", selection: Binding(
            get: { model.archiveProjectId ?? "" },
            set: { model.chooseArchiveProject($0.isEmpty ? nil : $0) }
        )) {
            Text("All projects").tag("")
            ForEach(client.projects) { project in
                Text(project.name).tag(project.id)
            }
        }
        .frame(maxWidth: 280)
        Picker("Mission", selection: Binding(
            get: { model.archiveMissionId ?? "" },
            set: { model.chooseArchiveMission($0.isEmpty ? nil : $0) }
        )) {
            Text("All missions").tag("")
            ForEach(client.missions.filter { model.archiveProjectId == nil || $0.projectId == model.archiveProjectId }) { mission in
                Text(model.archiveProjectId == nil
                     ? "\(mission.title) · \(client.project(mission.projectId)?.name ?? "Unknown project")"
                     : mission.title).tag(mission.id)
            }
        }
        .frame(maxWidth: 320)
    }

    private var archiveList: some View {
        List(sessions) { session in
            HStack(spacing: 16) {
                Button { model.open(session: session.id) } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(session.title).font(.headline).foregroundStyle(Theme.foreground)
                        Text(client.project(session.projectId)?.name ?? session.cwd.abbreviatingHome)
                            .font(.caption).foregroundStyle(Theme.mutedForeground)
                        if let archivedAt = session.archivedAt {
                            Text("Archived \(Date(timeIntervalSince1970: archivedAt / 1000).formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption).foregroundStyle(Theme.faintForeground)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Read archived chat")
                SessionArchiveAction(session: session)
                    .buttonStyle(.bordered)
            }
            .padding(.vertical, 8)
            .contextMenu {
                Button("Read Chat") { model.open(session: session.id) }
                SessionRenameAction(session: session)
                SessionArchiveAction(session: session)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }
}

/// Used in the toolbar, session context menu, archive browser, and archived composer.
struct SessionArchiveAction: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let pending = model.pendingSessionActions.contains(session.id)
        Button {
            model.setArchived(!session.isArchived, sessionId: session.id)
        } label: {
            Label(title(pending: pending), icon: session.isArchived ? PilotIcon.restore : PilotIcon.archive)
        }
        .disabled(pending || (!session.isArchived && !session.canArchive))
        .help(session.isArchived ? "Restore this chat to send messages again" :
              session.isWorking ? "Stop the session before archiving it" : "Archive chat. History and workspace are kept.")
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
                    .font(.callout.weight(.medium))
                Text("Restore to send messages. History and workspace are kept.")
                    .font(.caption).foregroundStyle(Theme.mutedForeground)
            }
            Spacer()
            SessionArchiveAction(session: session)
                .buttonStyle(.bordered)
        }
        .padding(14)
        .card(radius: 14)
        .frame(maxWidth: Theme.column)
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
    }
}
