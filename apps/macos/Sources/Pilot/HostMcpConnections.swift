import PilotCore
import SwiftUI

struct HostMcpConnections: View {
    let hosts: HostClients
    let localHost: HostRef?
    @StateObject private var roster: HostMcpRoster
    init(hosts: HostClients, localHost: HostRef?) {
        self.hosts = hosts; self.localHost = localHost
        _roster = StateObject(wrappedValue: HostMcpRoster(hosts: hosts, local: localHost))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if localHost == nil { SettingsSection("Local") { SettingsRow { SettingsNote("Waiting for the Local connection.") } } }
            ForEach(roster.rows) { row in
                HostMcpConnectionSection(host: row.host, name: row.name, available: row.available, hosts: hosts, client: row.client)
                    .id(row.host)
            }
        }
        .onChange(of: localHost, initial: true) { _, value in roster.update(local: value) }
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
