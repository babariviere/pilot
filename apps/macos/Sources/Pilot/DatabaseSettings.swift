import PilotCore
import SwiftUI

/// Owns one host/project load and save. No secret is persisted in app preferences or replicated state.
@MainActor
final class ProjectDatabaseEditor: ObservableObject {
    @Published var environments: [DatabaseEnvironmentDraft] = []
    @Published private(set) var snapshot: ProjectDatabaseSettings?
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    private var baseline: [DatabaseEnvironmentDraft] = []
    private var generation = UUID()

    var hasChanges: Bool { snapshot != nil && environments != baseline }
    var validationError: String? {
        if Set(environments.map(\.name)).count != environments.count { return "Environment names must be unique." }
        return environments.compactMap(\.validationError).first
    }

    func invalidate() { generation = UUID(); environments = []; baseline = []; snapshot = nil; busy = false }

    func load(_ read: () async throws -> ProjectDatabaseSettings) async {
        guard !busy else { return }
        let token = generation
        busy = true
        // A failed reload must not leave an editable stale snapshot.
        snapshot = nil
        environments = []
        baseline = []
        error = nil
        do {
            let value = try await read()
            guard token == generation else { return }
            adopt(value)
        } catch {
            guard token == generation else { return }
            self.error = error.localizedDescription
            if (error as? ClientError)?.status == 422 {
                self.snapshot = nil
                environments = []
                baseline = []
            }
        }
        if token == generation { busy = false }
    }

    func save(_ write: (ProjectDatabaseSettingsUpdate) async throws -> ProjectDatabaseSettings) async {
        guard !busy, let snapshot, validationError == nil else { return }
        let token = generation
        busy = true
        error = nil
        let request = ProjectDatabaseSettingsUpdate(revision: snapshot.revision, environments: environments.map(\.update))
        do {
            let value = try await write(request)
            guard token == generation else { return }
            adopt(value)
        } catch {
            guard token == generation else { return }
            self.error = error.localizedDescription
            if (error as? ClientError)?.status == 422 {
                self.snapshot = nil
                environments = []
                baseline = []
            }
        }
        if token == generation { busy = false }
    }

    private func adopt(_ value: ProjectDatabaseSettings) {
        snapshot = value
        environments = value.environments.map { .init(stored: $0) }
        baseline = environments
    }
}

struct ProjectDatabaseSettingsSection: View {
    let projectId: String
    let host: HostRef
    let hosts: ClientDirectory
    @StateObject private var editor = ProjectDatabaseEditor()

    var body: some View {
        SettingsSection("Databases") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Postgres connections on this host, for this project's Build chats. Results are shared with the model provider.")
                    .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                if editor.busy && editor.snapshot == nil {
                    ProgressView().controlSize(.small)
                } else if editor.snapshot != nil {
                    if editor.environments.isEmpty {
                        Text("No database environments configured.")
                            .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                    }
                    ForEach($editor.environments) { $environment in
                        DisclosureGroup(environment.name.isEmpty ? "New environment" : environment.name) {
                            VStack(alignment: .leading, spacing: 12) {
                                TextField("Environment name", text: $environment.name)
                                    .textFieldStyle(.roundedBorder)
                                    .disabled(environment.read.stored != nil || environment.write.stored != nil)
                                DatabaseConnectionFields(title: "Read", connection: $environment.read)
                                DatabaseConnectionFields(title: "Write", connection: $environment.write)
                                Button("Remove Environment", role: .destructive) {
                                    editor.environments.removeAll { $0.id == environment.id }
                                }
                            }.padding(.top, 8)
                        }
                    }
                    Button("Add Environment") { editor.environments.append(.init()) }
                    if editor.hasChanges {
                        if let problem = editor.validationError { InlineProblem(problem) }
                        HStack {
                            Button("Revert Databases") { Task { await reload() } }
                            Button("Save Databases") { Task { await save() } }
                                .disabled(editor.validationError != nil)
                        }
                    }
                }
                if let error = editor.error {
                    InlineProblem(error)
                    Button("Reload Databases") { Task { await reload() } }
                }
                Text("New connections ask for approval. Write access also covers reads. Saving does not change existing chat grants.")
                    .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            }.padding(.vertical, 8)
        }
        .disabled(editor.busy)
        .task { await reload() }
        .onDisappear { editor.invalidate() }
    }

    private func reload() async {
        await editor.load {
            try await hosts.githubRequest(on: host, path: "api/projects/\(projectId)/databases",
                                          body: Optional<ProjectDatabaseSettingsUpdate>.none, method: "GET")
        }
    }

    private func save() async {
        await editor.save {
            try await hosts.githubRequest(on: host, path: "api/projects/\(projectId)/databases", body: $0, method: "PUT")
        }
    }
}

private struct DatabaseConnectionFields: View {
    let title: String
    @Binding var connection: DatabaseConnectionDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Enable \(title.lowercased()) connection", isOn: $connection.enabled)
            if connection.enabled {
                if let stored = connection.stored {
                    Text(stored.summary).font(.pilot(.label)).textSelection(.enabled)
                    if stored.hasCredentials {
                        Text("Credentials or connection parameters retained on this host.")
                            .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                    }
                }
                SecureField(connection.stored == nil ? "Postgres URL (including password)" : "Replacement URL (leave empty to keep stored connection)",
                            text: $connection.replacementURL)
                    .textFieldStyle(.roundedBorder)
                    .help("postgres://user:password@host:5432/database. The full URL is never sent back to the app.")
                Picker("Access", selection: $connection.access) {
                    Text("Ask each chat").tag("ask")
                    Text("Allow automatically").tag("allow")
                }.frame(maxWidth: 320, alignment: .leading)
                if title == "Write" {
                    Text("Write connections permit reads and changes to data.")
                        .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                }
            }
        }
    }
}
