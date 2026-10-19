import PilotCore
import SwiftUI

struct HostMcpConnections: View {
    let hosts: HostClients
    let localHost: HostRef?
    @StateObject private var roster: HostMcpRoster
    @State private var sharing: Target?
    private struct Target: Identifiable { let host: HostRef; var id: HostRef { host } }
    init(hosts: HostClients, localHost: HostRef?) {
        self.hosts = hosts; self.localHost = localHost
        _roster = StateObject(wrappedValue: HostMcpRoster(hosts: hosts, local: localHost))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsSection(explanation: "Each host connects and signs in independently. Setup sharing never copies tokens or authenticated sessions, and does not proxy calls through this Mac.") {
                SettingsRow("Share Local setup", detail: "Review initial nonsecret setup for a trusted devbox. Existing MCP configuration stays manual.") {
                    Menu("Share setup…") {
                        ForEach(roster.rows.filter { $0.host.hostId != "local" }) { row in
                            Button(row.name) { sharing = Target(host: row.host) }
                                .disabled(!row.available)
                        }
                    }
                    .disabled(localHost == nil || !roster.rows.contains(where: { $0.host.hostId != "local" }))
                    .controlSize(.small)
                }
            }
            if localHost == nil { SettingsSection("Local") { SettingsRow { SettingsNote("Waiting for the Local connection.") } } }
            ForEach(roster.rows) { row in
                HostMcpConnectionSection(host: row.host, name: row.name, available: row.available, hosts: hosts, client: row.client)
                    .id(row.host)
            }
        }
        .sheet(item: $sharing) { target in
            if let localHost {
                McpSetupShareSheet(source: localHost, target: target.host, targetName: name(target.host), hosts: hosts)
            }
        }
        .onChange(of: localHost, initial: true) { _, value in roster.update(local: value) }
    }

    private func name(_ host: HostRef) -> String {
        roster.rows.first(where: { $0.host == host })?.name ?? host.hostId
    }
}

struct HostMcpConnectionSection: View {
    let host: HostRef
    let name: String
    let available: Bool
    @ObservedObject private var store: McpStatusStore
    @StateObject private var actions: HostMcpActions
    @State private var expanded: Bool
    @State private var showAll = false

    init(host: HostRef, name: String, available: Bool, hosts: HostClients, client: PilotClient) {
        self.host = host; self.name = name; self.available = available
        _store = ObservedObject(wrappedValue: client.mcp)
        _actions = StateObject(wrappedValue: HostMcpActions(host: host, hosts: hosts))
        _expanded = State(initialValue: host.hostId == "local")
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            content
        } label: {
            HStack {
                Text(name).font(.pilot(.body, weight: .semibold))
                Spacer()
                Text(!available ? "Disconnected" : store.status?.checking == true ? "Checking…" : store.status.map { McpStatusText.checkResult($0).text } ?? "Not checked")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
    }

    private var content: some View {
        return SettingsSection(explanation: available
            ? "This host's global Pi MCP servers. Checks and authentication target this host only."
            : "Disconnected. Retained connection states may be out of date; remote agents can still be running.") {
            SettingsRow("MCP connections", detail: store.status?.checking == true ? "Checking on this host…" : nil) {
                Button("Check now") { Task { await actions.perform(.check) } }
                    .disabled(!available || actions.busy || store.status?.checking == true).controlSize(.small)
            }
            if let status = store.status {
                if status.servers.isEmpty {
                    SettingsRow { SettingsNote("No MCP servers reported on this host. Review the sharing limits above, or configure Pi on this host directly.") }
                }
                ForEach(showAll ? status.servers : Array(status.servers.prefix(8))) { server in
                    HostMcpServerControl(server: server, hostName: name, available: available, actions: actions)
                }
                if status.servers.count > 8 {
                    SettingsRow { Button(showAll ? "Show fewer servers" : "Show all \(status.servers.count) servers") { showAll.toggle() }.buttonStyle(.link) }
                }
                if let count = status.configProblems, count > 0 {
                    SettingsRow { InlineProblem("\(count) MCP configuration entries need attention on \(name). Use this host's pi mcp list for details.") }
                }
            } else {
                SettingsRow { SettingsNote(available ? "No completed MCP check reported yet." : "Reconnect to load this host's MCP servers.") }
            }
            if let problem = actions.problem { SettingsRow { InlineProblem(problem) } }
            if let problem = store.actionError { SettingsRow { InlineProblem(problem) } }
        }
        .sheet(isPresented: Binding(get: { actions.signInOnHost != nil }, set: { if !$0 { actions.signInOnHost = nil } })) {
            SheetScaffold("Sign in on \(name)", subtitle: "Credentials stay on this devbox.") {
                SettingsNote("This runtime's browser sign-in waits for a callback on the devbox, not this Mac. Automatic callback forwarding is not supported.")
                SettingsNote("In a terminal on \(name), run the command below with this host's Pi CLI. Open the authorization link on your Mac, then paste the redirected URL into that devbox terminal when Pi asks.")
                Text("pi mcp login -- \(actions.signInOnHost ?? "")").font(.pilot(.body)).textSelection(.enabled)
                SettingsNote("Use a directory without project MCP overrides, so this signs in to the global server shown here.")
                SettingsNote("Use the same Pi agent directory as pilotd on this devbox. For a custom directory, set PI_CODING_AGENT_DIR in that terminal.")
                if actions.signInAgainOnHost {
                    SettingsNote("Pi's CLI keeps a working sign-in. To intentionally replace its account, sign out on this devbox first. This removes its current credentials; cancelling a later login will not restore them. Nothing is signed out automatically.")
                    Text("pi mcp logout -- \(actions.signInOnHost ?? "")").font(.pilot(.body)).textSelection(.enabled)
                    SettingsNote("Then run the login command above. If you only need to recheck a working connection, close this sheet and use Check now instead.")
                }
                SettingsNote("The Pi CLI must be available on this devbox. No packages are installed automatically. Afterwards, use Check now on \(name). Nothing runs on Local instead.")
            }
        }
    }
}

/// Exact production action row, independently mountable by native action fixtures.
struct HostMcpServerControl: View {
    let server: McpServerStatus
    let hostName: String
    let available: Bool
    @ObservedObject var actions: HostMcpActions

    var body: some View {
        SettingsRow(server.name, detail: available ? McpServerRowText.state(server).text : "Disconnected · last-known state") {
            if let action = McpServerRowText.action(server) {
                Button(action == .cancel ? "Cancel sign-in" : action == .signIn ? "Sign in…" : "Check again") {
                    let command: HostMcpAction
                    switch action {
                    case .cancel:
                        guard let startedAt = server.signIn?.startedAt else { return }
                        command = .cancel(startedAt: startedAt)
                    case .signIn: command = .signIn
                    case .checkAgain: command = .check
                    }
                    Task { await actions.perform(command, server: server.name) }
                }
                .controlSize(.small).disabled(!available || actions.busy)
            }
        }
        .help(server.transport == .stdio && server.state == .failed
            ? "Check the executable and dependencies with pi mcp list on \(hostName). Nothing is installed automatically."
            : "\(server.name) on \(hostName)")
        .contextMenu {
            if server.canSignIn == true, server.state == .connected {
                Button("Sign in again on \(hostName)…") { Task { await actions.perform(.signInAgain, server: server.name) } }
                    .disabled(!available || actions.busy)
            }
            Button("Check on \(hostName)") { Task { await actions.perform(.check, server: server.name) } }
                .disabled(!available || actions.busy)
        }
    }
}

private struct McpSetupShareSheet: View {
    let targetName: String
    @StateObject private var model: McpSetupSharing
    @State private var operation: Task<Void, Never>?
    init(source: HostRef, target: HostRef, targetName: String, hosts: HostClients) {
        self.targetName = targetName
        _model = StateObject(wrappedValue: McpSetupSharing(source: source, target: target, hosts: hosts))
    }
    var body: some View {
        SheetScaffold("Share MCP setup", subtitle: "Local → \(targetName)",
            primary: SheetPrimaryAction(title: model.uncertain ? "Check result" : "Apply reviewed setup",
                enabled: !model.busy && (model.uncertain || !model.selected.isEmpty), action: {
                    operation = Task {
                        defer { operation = nil }
                        if model.uncertain { await model.checkResult() } else { await model.apply() }
                    }
                })) {
            SettingsNote("Only the reviewed literal setup is shared. Tokens, auth files, secret values, local paths and installations are never copied. Existing target entries are kept.")
            if model.busy { ProgressView().controlSize(.small) }
            if let review = model.review {
                SettingsNote("Only missing server names are added. Existing entries, authentication and other settings stay on this devbox. Don't edit MCP configuration with older Pi versions or a text editor while applying.")
                if review.local.entries.isEmpty { SettingsNote("Local has no shareable server entries to review.") }
                if review.local.invalidNames > 0 { SettingsNote("\(review.local.invalidNames) Local entries have unsupported names and need manual setup on the target.") }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(review.local.entries) { entry in
                            McpSetupShareRow(entry: entry, targetName: targetName, model: model)
                        }
                    }
                }.frame(maxHeight: 320)
            }
            if let problem = model.problem { InlineProblem(problem) }
            if let notice = model.notice { SettingsNote(notice) }
        }
        .task { await model.prepare() }
        .onDisappear { operation?.cancel(); operation = nil; model.cancelReview() }
    }
}

/// Same reviewed checkbox in the sheet and mounted native interaction fixtures.
struct McpSetupShareRow: View {
    let entry: McpSetupEntry
    let targetName: String
    @ObservedObject var model: McpSetupSharing
    var body: some View {
        Toggle(isOn: Binding(get: { model.selected.contains(entry.name) }, set: { selected in
            if selected { model.selected.insert(entry.name) } else { model.selected.remove(entry.name) }
        })) {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.name).font(.pilot(.body))
                if model.selectable(entry), let config = entry.config {
                    Text(config.url ?? "PATH executable: \(config.command ?? "")").font(.pilot(.caption))
                    Text("Enabled: \(config.enabled == false ? "No" : "Yes") · exposure: \(config.exposure ?? "codemode") · timeout: \(Int(config.timeout ?? 60))s")
                        .font(.pilot(.caption))
                } else {
                    Text(model.entryNotice(entry, targetName: targetName)).font(.pilot(.caption))
                }
            }.foregroundStyle(Theme.mutedForeground)
        }
        .toggleStyle(.checkbox).disabled(!model.selectable(entry) || model.busy || model.uncertain)
    }
}
