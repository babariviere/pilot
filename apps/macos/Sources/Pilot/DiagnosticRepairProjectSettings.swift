import Foundation
import PilotCore
import SwiftUI

extension AppModel {
    func diagnosticRepairProject(on host: HostRef) async throws -> DiagnosticRepairProjectStatus {
        let client = try hosts.endpoint(host)
        if client.usesSessionFixtures { return client.fixtureRepairProject ?? .init(state: .missing, revision: 0) }
        return try await hosts.githubRequest(on: host, path: "api/diagnostics/repair-project",
                                             body: Optional<String>.none, method: "GET")
    }

    func configureDiagnosticRepairProject(_ request: DiagnosticRepairProjectSetup) async throws -> DiagnosticRepairProjectStatus {
        let client = try hosts.endpoint(request.host)
        if client.usesSessionFixtures {
            guard client.fixtureRepairProject?.state != .invalid,
                  request.origin == DiagnosticRepairProjectBinding.requiredOrigin,
                  request.expectedRevision == (client.fixtureRepairProject?.revision ?? 0),
                  client.projects.contains(where: { $0.id == request.projectId && $0.path == request.path }),
                  client.fixtureProjectOrigins[request.projectId]?.identity == DiagnosticRepairProjectBinding.requiredOrigin
            else { throw ClientError("Review a verified Pilot source project on this host.") }
            let binding = DiagnosticRepairProjectBinding(id: UUID().uuidString.lowercased(), revision: request.expectedRevision + 1,
                host: request.host, projectId: request.projectId, path: request.path, configuredAt: ISO8601DateFormatter().string(from: Date()))
            let status = DiagnosticRepairProjectStatus(state: .available, revision: binding.revision, binding: binding)
            client.fixtureRepairProject = status
            return status
        }
        return try await hosts.githubRequest(on: request.host, path: "api/diagnostics/repair-project", body: request, method: "PUT")
    }
}

struct DiagnosticRepairProjectSettings: View {
    @EndpointClient private var client
    @State private var showingSetup = false

    init(client: PilotClient? = nil) { _client = EndpointClient(client) }

    var body: some View {
        SettingsSection("Repair project", explanation: "Diagnostic repairs always use a source checkout of Pilot on this host, never the diagnosed chat’s project. Configure it explicitly once; each repair still requires review and confirmation.") {
            SettingsRow("Pilot source checkout", detail: "No automatic project selection, clone, import or host switch.") {
                Button("Configure…") { showingSetup = true }.controlSize(.small).disabled(!client.connected)
            }
        }
        .sheet(isPresented: $showingSetup) {
            if let host = client.hostIdentity { DiagnosticRepairProjectSetupSheet(host: host) }
        }
    }
}

struct DiagnosticRepairProjectSetupSheet: View {
    let host: HostRef
    var onSaved: (DiagnosticRepairProjectStatus) -> Void = { _ in }
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var status: DiagnosticRepairProjectStatus?
    @State private var selectedProjectId = ""
    @State private var verifiedProject: Project?
    @State private var error: String?
    @State private var verifying = false
    @State private var saving = false

    private var client: PilotClient { host == app.localHost ? app.client : app.hosts.presentationClient(host) }
    private var selected: Project? { client.projects.first { $0.id == selectedProjectId } }
    private var canSave: Bool {
        !saving && !verifying && client.connected && status != nil && status?.state != .invalid &&
            selected != nil && selected == verifiedProject
    }

    var body: some View {
        SheetScaffold("Configure the Pilot repair project",
                      subtitle: "Choose an existing source checkout on this host. This configures a destination, not permission to start a repair.",
                      error: error,
                      primary: SheetPrimaryAction(title: saving ? "Saving…" : "Use this checkout", enabled: canSave, action: save),
                      cancel: { dismiss() }, width: 560) {
            VStack(alignment: .leading, spacing: 14) {
                LabeledContent("Execution host", value: host == app.localHost ? "Local" : host.hostId)
                Text("\(host.daemonId) · \(host.lineageId)")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
                if status?.state == .invalid {
                    Text("The existing configuration cannot be verified. It has been preserved and repairs are disabled. Resolve the configuration before replacing it.")
                        .font(.pilot(.body)).foregroundStyle(Theme.destructive)
                }
                LabeledContent("Registered project") {
                    Picker("Registered project", selection: $selectedProjectId) {
                        Text("Choose a checkout").tag("")
                        ForEach(client.projects) { project in Text("\(project.name) · \(project.path)").tag(project.id) }
                    }.labelsHidden().frame(maxWidth: 340)
                }
                if let selected {
                    LabeledContent("Source directory") { Text(selected.path).textSelection(.enabled) }
                    if verifying { ProgressView("Verifying local Git origin…").controlSize(.small) }
                    else if verifiedProject == selected {
                        Label("Verified origin: github.com/babariviere/pilot", icon: PilotIcon.complete)
                            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    }
                } else {
                    Text("If no Pilot source checkout is registered, add an existing checkout first. Nothing is imported or cloned here.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                Text("The registered project, canonical directory, Git origin and host identity are checked again at repair admission. Names are not identity. Use a canonical directory, not a symlink. Cancelling changes nothing.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .task(id: host) { await load() }
        .task(id: selectedProjectId) { await verify() }
        .interactiveDismissDisabled(saving)
    }

    private func load() async {
        do {
            let loaded = try await app.diagnosticRepairProject(on: host)
            guard !Task.isCancelled else { return }
            status = loaded
            if let binding = loaded.binding, binding.matches(host: host, projects: client.projects) {
                selectedProjectId = binding.projectId
            }
        } catch { self.error = error.localizedDescription }
    }

    private func verify() async {
        verifiedProject = nil
        guard let candidate = selected else { return }
        verifying = true; error = nil
        defer { if selectedProjectId == candidate.id { verifying = false } }
        do {
            let reference = HostResourceRef(host: host, kind: .project, localId: candidate.id)
            let origin = try await app.hosts.perform(reference, kind: .project) { try await $0.projectOrigin($1) }
            guard !Task.isCancelled, selected == candidate else { return }
            guard origin.identity == DiagnosticRepairProjectBinding.requiredOrigin else {
                throw ClientError("This is not a verified Pilot source checkout. Its local Git origin must identify github.com/babariviere/pilot.")
            }
            verifiedProject = candidate
        } catch { if !Task.isCancelled && selected == candidate { self.error = error.localizedDescription } }
    }

    private func save() {
        guard canSave, let candidate = verifiedProject, let status else { return }
        saving = true; error = nil
        let request = DiagnosticRepairProjectSetup(expectedRevision: status.revision, host: host,
            projectId: candidate.id, path: candidate.path, origin: DiagnosticRepairProjectBinding.requiredOrigin)
        Task {
            defer { saving = false }
            do {
                let result = try await app.configureDiagnosticRepairProject(request)
                guard result.state == .available, result.binding?.matches(host: host, projects: client.projects) == true else {
                    throw ClientError("The configured checkout changed. Review the current host and source project again.")
                }
                onSaved(result); dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
