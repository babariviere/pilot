import PilotCore
import SwiftUI

/// Settings destination. The Local Connections screen is deliberately unchanged.
@MainActor
struct DevboxSettings: View {
    @ObservedObject var hosts: HostClients
    private let loadPackage: DevboxPackageLoader
    private let navigate: (HostResourceRef) -> Void

    init(hosts: HostClients, loadPackage: DevboxPackageLoader? = nil,
         navigate: @escaping (HostResourceRef) -> Void = { _ in }) {
        self.hosts = hosts; self.loadPackage = loadPackage ?? { try await DevboxRuntimePackage.load() }
        self.navigate = navigate
    }

    var body: some View {
        SettingsPage("Devboxes", subtitle: "Keep local and remote work together, with independent execution and sign-ins.") {
            DevboxSettingsContent(hosts: hosts, loadPackage: loadPackage, navigate: navigate)
        }
    }
}

/// Embeddable sections without a second settings page, navigation stack or global endpoint selection.
@MainActor
struct DevboxSettingsContent: View {
    @ObservedObject var hosts: HostClients
    private let loadPackage: DevboxPackageLoader
    private let navigate: (HostResourceRef) -> Void
    @State private var selectedHost: HostRef?
    @State private var adding = false
    @State private var connecting: Set<HostRef> = []
    @State private var problem: String?

    init(hosts: HostClients, loadPackage: DevboxPackageLoader? = nil,
         navigate: @escaping (HostResourceRef) -> Void = { _ in }) {
        self.hosts = hosts; self.loadPackage = loadPackage ?? { try await DevboxRuntimePackage.load() }
        self.navigate = navigate
    }

    private var devboxes: [OfflineHostSnapshot] {
        hosts.offlineHosts.values.sorted { $0.configuration.alias.localizedStandardCompare($1.configuration.alias) == .orderedAscending }
    }

    var body: some View {
        SettingsSection("Your devboxes", explanation: "Use an existing SSH alias for a dedicated personal Linux x86-64 devbox. Pilot verifies and installs its own runtime; SSH still owns authentication and host-key checks.") {
            SettingsRow("Local", detail: "Your Mac remains independent of remote connections.") { Text("This Mac").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground) }
            ForEach(devboxes, id: \.host) { snapshot in hostRow(snapshot) }
            if devboxes.isEmpty { SettingsRow { SettingsNote("No remote devboxes yet. Setup does not require a project, chat or model login.") } }
            SettingsRow {
                Button("Add devbox…") { adding = true }.controlSize(.small).disabled(hosts.persistenceError != nil)
            }
            if let problem { SettingsRow { InlineProblem(problem) } }
            if let problem = hosts.persistenceError { SettingsRow { InlineProblem(problem) } }
        }
        // EmptyView is not a mounted presentation anchor. Keep the sheet on the
        // section that owns the Add button, including after cancellation.
        .sheet(isPresented: $adding) {
            DevboxAddSheet(hosts: hosts, loadPackage: loadPackage) { host in
                selectedHost = host; adding = false
            }
        }
        if let host = selectedHost, let snapshot = hosts.offlineHosts[host] {
            SettingsSection(snapshot.configuration.alias, explanation: "All actions below target this saved devbox, never Local. Closing a connection does not stop remote agents.") {
                SettingsRow("Saved identity", detail: "Installation \(host.daemonId) · history \(host.lineageId)") { EmptyView() }
            }
            DevboxMachineSection(host: host, hosts: hosts).id(host)
            TelemetrySettingsSection(client: hosts.presentationClient(host), localApp: false).id(host)
            DiagnosticRepairProjectSettings(client: hosts.presentationClient(host)).id(host)
            DevboxProviderSetup(host: host, hosts: hosts).id(host)
            DevboxGitHubSetup(host: host, hosts: hosts).id(host)
            DevboxUpdateSection(host: host, hosts: hosts, loadPackage: loadPackage, navigate: navigate).id(host)
        }
    }

    private func hostRow(_ snapshot: OfflineHostSnapshot) -> some View {
        let host = snapshot.host, available = hosts.available.contains(host)
        return SettingsRow {
            Button { selectedHost = host } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(snapshot.configuration.alias).font(.pilot(.body)).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.middle)
                    Text(available ? "Connected" : "Disconnected · remote work may still be running")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.rowButtonStyle()
            .accessibilityLabel("\(snapshot.configuration.alias), \(available ? "connected" : "disconnected"). Show setup and updates")
        } control: {
            HStack(spacing: 8) {
                if connecting.contains(host) { ProgressView().controlSize(.small) }
                if available {
                    Button("Disconnect") { Task { await hosts.disconnect(host) } }.controlSize(.small)
                        .help("Close only this Mac's SSH forward. Remote agents continue.")
                } else {
                    Button("Reconnect") {
                        guard connecting.insert(host).inserted else { return }
                        Task {
                            defer { connecting.remove(host) }
                            do { try await hosts.reconnect(host); problem = nil }
                            catch { problem = "Could not reconnect this saved devbox. Check the SSH alias and pinned identity. No operation was sent to Local." }
                        }
                    }.controlSize(.small).disabled(connecting.contains(host))
                }
            }
        }
    }
}

@MainActor
private struct DevboxAddSheet: View {
    @ObservedObject var hosts: HostClients
    @StateObject private var model: DevboxSetupModel
    @State private var alias = ""
    @State private var authorized = false
    let onComplete: (HostRef) -> Void
    @Environment(\.dismiss) private var dismiss

    init(hosts: HostClients, loadPackage: @escaping DevboxPackageLoader, onComplete: @escaping (HostRef) -> Void) {
        self.hosts = hosts; self.onComplete = onComplete
        _model = StateObject(wrappedValue: DevboxSetupModel(loadPackage: loadPackage, actions: .live(hosts)))
    }

    private var duplicateAlias: Bool {
        hosts.offlineHosts.values.contains { $0.configuration.alias == alias.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private var title: String {
        if model.candidate != nil { return "Confirm devbox identity" }
        return model.outdated != nil ? "Update devbox runtime" : "Add devbox"
    }

    private var primaryTitle: String {
        if model.candidate != nil { return "Save and connect" }
        return model.outdated != nil ? "Update devbox" : "Set up devbox"
    }

    private var primaryEnabled: Bool {
        !model.busy && (model.candidate != nil || model.outdated != nil || (authorized && !alias.isEmpty && !duplicateAlias))
    }

    var body: some View {
        SheetScaffold(title, subtitle: "Independent setup over standard SSH",
            error: model.problem, primary: SheetPrimaryAction(title: primaryTitle, enabled: primaryEnabled, action: {
                    Task {
                        if model.candidate != nil { await model.confirmEnrollment() }
                        else if model.outdated != nil { await model.updateRuntime() }
                        else { await model.prepare(alias: alias) }
                        if let host = model.completed { onComplete(host) }
                    }
                }), cancel: { Task { await model.cancel(); dismiss() } }, width: 480) {
            if let candidate = model.candidate {
                SettingsNote("The owned SSH forward passed compatibility and service-isolation checks. Save this installation and history identity before connecting. Future reconnects must match both.")
                SettingsSection {
                    SettingsRow("SSH alias", detail: alias) { EmptyView() }
                    SettingsRow("Installation", detail: candidate.daemonId) { EmptyView() }
                    SettingsRow("History", detail: candidate.lineageId) { EmptyView() }
                }
            } else if let outdated = model.outdated {
                SettingsNote("This devbox already runs another Pilot version from an earlier setup. Updating installs the verified \(model.packageVersion ?? "package") runtime through the update flow, which waits for active work and keeps its history. You confirm its identity afterwards.")
                SettingsSection {
                    SettingsRow("SSH alias", detail: alias) { EmptyView() }
                    SettingsRow("Installation", detail: outdated.daemonId) { EmptyView() }
                    SettingsRow("History", detail: outdated.lineageId) { EmptyView() }
                }
                if model.busy { HStack { ProgressView().controlSize(.small); SettingsNote("Updating the devbox runtime. This can take a few minutes…") } }
            } else {
                TextField("Existing SSH alias", text: $alias).textFieldStyle(.roundedBorder).disabled(model.busy)
                    .accessibilityLabel("Existing SSH alias")
                SettingsNote("First make sure ssh <alias> already works outside Pilot. Keys, passwords, host trust and privileged prerequisite changes remain outside the app.")
                SettingsToggle("Set up my dedicated personal devbox", detail: "Authorize installing and enabling Pilot's verified runtime and user service. No Mac provider credentials will be copied.", isOn: $authorized).disabled(model.busy)
                if duplicateAlias { InlineProblem("This alias is already saved. Reconnect its existing pinned entry instead of enrolling it again.") }
                if model.busy { HStack { ProgressView().controlSize(.small); SettingsNote("Preparing the verified runtime and checking the devbox…") } }
            }
        }
        .interactiveDismissDisabled(model.busy)
        .onDisappear { Task { await model.cancel() } }
    }
}

/// Static mock fragment for the parent-owned screenshot artifact. It is not a live setup result.
@MainActor
struct DevboxSettingsMockFragment: View {
    var body: some View {
        SettingsColumn {
            PageHeader("Devboxes", subtitle: "Independent work, together in Pilot")
            SettingsSection("Your devboxes", explanation: "Remote work keeps running through disconnection, Mac sleep and app quit.") {
                SettingsRow("Local", detail: "This Mac") { Text("Connected").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground) }
                SettingsRow("Personal build box", detail: "Disconnected · remote work may still be running") { Button("Reconnect") {}.controlSize(.small) }
                SettingsRow { Button("Add devbox…") {}.controlSize(.small) }
            }
            SettingsSection("Providers", explanation: "Sign in independently. No project or working model is required.") {
                SettingsRow("Anthropic", detail: "No stored sign-in") { Button("Sign in") {}.controlSize(.small) }
                SettingsRow("OpenAI Codex", detail: "Stored sign-in present. Provider access is not yet verified.") { Button("Sign in again") {}.controlSize(.small) }
            }
            SettingsSection("Runtime updates", explanation: "Waiting never silently stops live work.") {
                SettingsRow("Waiting for work to finish", detail: "A workspace terminal is still open. Close it explicitly in its chat.") { Button("Open chat") {}.controlSize(.small) }
                SettingsRow { SettingsNote("Cancellation requested. The devbox must confirm it before this update is cancelled.") }
            }
        }
    }
}
