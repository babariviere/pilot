import PilotCore
import SwiftUI

@MainActor
private final class ArchiveBrowserState: ObservableObject {
    @Published var query = ""
}

/// Archives remain in the client's WebSocket inventory, but never in normal session lists.
struct ArchiveView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var browser = ArchiveBrowserState()

    private var sessions: [SessionSummary] {
        let query = browser.query.trimmingCharacters(in: .whitespacesAndNewlines)
        return client.archivedSessions.filter { session in
            (model.archiveProjectId == nil || session.projectId == model.archiveProjectId)
                && (query.isEmpty || [session.title, session.cwd, session.branch ?? "",
                                     client.project(session.projectId)?.name ?? ""]
                    .contains { $0.localizedCaseInsensitiveContains(query) })
        }.sorted { ($0.archivedAt ?? 0) > ($1.archivedAt ?? 0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label("Archived chats", systemImage: "archivebox")
                    .font(.title2.weight(.semibold))
                Spacer()
                Picker("Project", selection: Binding(
                    get: { model.archiveProjectId ?? "" },
                    set: { model.archiveProjectId = $0.isEmpty ? nil : $0 }
                )) {
                    Text("All projects").tag("")
                    ForEach(client.projects) { project in
                        Text(project.name).tag(project.id)
                    }
                }
                .frame(maxWidth: 280)
            }
            Text("History and workspaces are kept. Restore a chat to send messages again.")
                .font(.callout)
                .foregroundStyle(Theme.mutedForeground)
            TextField("Search archived chats", text: $browser.query)
                .textFieldStyle(.roundedBorder)
            if sessions.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "archivebox").font(.largeTitle)
                    Text(browser.query.isEmpty ? "No archived chats" : "No matching archived chats")
                }
                .foregroundStyle(Theme.mutedForeground)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
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
                        SessionArchiveAction(session: session)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .padding(24)
        .background(Theme.background)
        .navigationTitle("Archived chats")
        .toolbar {
            Button("Home") { model.newSession(in: nil) }
        }
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
            Label(title(pending: pending), systemImage: session.isArchived ? "arrow.uturn.backward" : "archivebox")
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
                Label("Archived chat · Read-only", systemImage: "archivebox")
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
