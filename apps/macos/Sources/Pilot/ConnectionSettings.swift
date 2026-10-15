import PilotCore
import SwiftUI

/// Settings › Connections: the user's global pi MCP servers as pilotd last found them, with sign-in where pi
/// can run it in the browser. Chats keep their own connections and pick up a new sign-in on their next turn.
struct ConnectionSettings: View {
    @ObservedObject private var store = AppModel.shared.client.mcp

    var body: some View {
        ConnectionSettingsContent(status: store.status, error: store.actionError)
    }
}

/// Stateless content, shared by native snapshots and the live settings page.
struct ConnectionSettingsContent: View {
    let status: McpStatus?
    var error: String?

    var body: some View {
        if let status {
            Section {
                if status.servers.isEmpty {
                    Text(status.checking ? "Checking MCP servers…" : "pi has no MCP servers yet.")
                        .font(.pilot(.label))
                        .foregroundStyle(Theme.mutedForeground)
                } else {
                    ForEach(status.servers) { server in McpServerRow(server: server) }
                }
            } header: {
                Text("MCP servers")
            } footer: {
                SettingsFooter(status.servers.isEmpty
                    ? "Add servers with pi mcp add or in ~/.pi/agent/mcp.json. Pilot checks again when that file changes."
                    : "From ~/.pi/agent/mcp.json. Pilot checks them when it starts and whenever pi's MCP files change, including a sign-in from a terminal. Run pi mcp list for full errors.")
            }
            if let count = status.configProblems, count > 0 {
                Section {
                    InlineProblem("\(count) \(count == 1 ? "entry" : "entries") in mcp.json \(count == 1 ? "is" : "are") invalid. Run pi mcp list for details.")
                }
            }
        } else {
            Section { ProgressView("Checking MCP servers…") }
        }
        if let error {
            Section { InlineProblem(error) }
        }
    }
}

/// The Connections sidebar row, counting servers that need the user. Only this row observes MCP status.
struct ConnectionsTabLabel: View {
    @ObservedObject private var store = AppModel.shared.client.mcp

    var body: some View {
        let count = store.needingUser.count
        Label(SettingsTab.connections.title, icon: SettingsTab.connections.icon)
            .badge(count)
            .accessibilityValue(count > 0 ? "\(count) \(count == 1 ? "server needs" : "servers need") you" : "")
    }
}

/// Sidebar footer, shown only while an MCP server waits for the user to sign in. Opens Settings › Connections.
/// Failing servers stay in Settings; chats that hit one show under Needs you.
struct McpSignInFooter: View {
    @ObservedObject private var store = AppModel.shared.client.mcp
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        let names = store.needingUser.filter { $0.state == .needsSignIn }.map(\.name)
        if let text = McpServerRowText.footer(names) {
            Button {
                AppModel.shared.settingsTab = .connections
                openSettings()
            } label: {
                HStack(spacing: 6) {
                    PilotSymbol(PilotIcon.signInRequired).foregroundStyle(Theme.blocked)
                    Text(text).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    Text("Sign in…").foregroundStyle(Theme.mutedForeground)
                }
                .font(.pilot(.small))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(Theme.sidebar)
            .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
            .help("Open Connections settings")
            .accessibilityLabel("\(text). Open Connections settings")
        }
    }
}

/// The header accessory: checks every server again.
struct McpCheckButton: View {
    @ObservedObject private var store = AppModel.shared.client.mcp
    @State private var busy = false

    var body: some View {
        let checking = store.status?.checking ?? true
        HStack(spacing: 6) {
            if checking { ProgressView().controlSize(.small) }
            Button("Check Now") {
                busy = true
                Task {
                    defer { busy = false }
                    await AppModel.shared.client.checkMcp()
                }
            }
            .controlSize(.small)
            .disabled(busy || checking)
            .help("Connect to every MCP server again")
        }
    }
}

/// One server: its name, a plain state line and at most one action (Sign in, Cancel or Check again).
/// Sign in again stays in the context menu.
struct McpServerRow: View {
    let server: McpServerStatus

    var body: some View {
        let text = McpServerRowText.state(server)
        LabeledContent {
            HStack(spacing: 6) {
                if text.waiting { ProgressView().controlSize(.small) }
                McpServerAction(server: server)
            }
        } label: {
            Text(server.name)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if text.attention {
                    PilotSymbol(server.state == .needsSignIn ? PilotIcon.signInRequired : PilotIcon.warning)
                        .accessibilityHidden(true)
                }
                Text(text.text).fixedSize(horizontal: false, vertical: true)
            }
            .font(.pilot(.caption))
            .foregroundStyle(text.attention ? Theme.blocked : Theme.mutedForeground)
        }
        .help(server.state == .failed ? "Run pi mcp list in a terminal for the full error." : "")
        .contextMenu {
            if server.canSignIn == true, server.state == .connected {
                Button("Sign in again") { Task { await AppModel.shared.client.startMcpSignIn(server.name, again: true) } }
            }
            Button("Check again") { Task { await AppModel.shared.client.checkMcp(server: server.name) } }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Wording of a server row, kept apart from the view for tests.
enum McpServerRowText {
    struct State: Equatable {
        let text: String
        let attention: Bool
        let waiting: Bool
    }

    static func state(_ server: McpServerStatus) -> State {
        if server.signIn?.state == .waiting {
            return State(text: McpStatusText.line(server), attention: false, waiting: true)
        }
        if let problem = McpStatusText.signInProblem(server) {
            return State(text: problem, attention: true, waiting: false)
        }
        return State(text: McpStatusText.line(server), attention: server.state.needsUser, waiting: false)
    }

    enum Action: Equatable { case signIn, cancel, checkAgain }

    /// The one visible action: sign-in when pi can run it, otherwise a recheck for a failing server.
    static func action(_ server: McpServerStatus) -> Action? {
        if server.signIn?.state == .waiting { return .cancel }
        if server.canSignIn == true, server.state == .needsSignIn { return .signIn }
        if server.state == .failed { return .checkAgain }
        return nil
    }

    /// The sidebar footer line, or nil when no server waits for a sign-in.
    static func footer(_ names: [String]) -> String? {
        switch names.count {
        case 0: nil
        case 1: "\(names[0]) needs sign-in"
        default: "\(names.count) MCP servers need sign-in"
        }
    }
}

private struct McpServerAction: View {
    let server: McpServerStatus
    @State private var busy = false

    var body: some View {
        if let action = McpServerRowText.action(server) {
            Button(title(action)) {
                busy = true
                Task {
                    defer { busy = false }
                    let client = AppModel.shared.client
                    switch action {
                    case .signIn: await client.startMcpSignIn(server.name)
                    case .cancel: await client.cancelMcpSignIn(server.name)
                    case .checkAgain: await client.checkMcp(server: server.name)
                    }
                }
            }
            .controlSize(.small)
            .disabled(busy)
            .help(help(action))
            .accessibilityLabel(accessibility(action))
        }
    }

    private func title(_ action: McpServerRowText.Action) -> String {
        switch action {
        case .signIn: "Sign in"
        case .cancel: "Cancel"
        case .checkAgain: "Check again"
        }
    }

    private func help(_ action: McpServerRowText.Action) -> String {
        switch action {
        case .signIn: "Opens your browser to sign in to \(server.name)"
        case .cancel: "Stop waiting for the browser"
        case .checkAgain: "Connect to \(server.name) again"
        }
    }

    private func accessibility(_ action: McpServerRowText.Action) -> String {
        switch action {
        case .signIn: "Sign in to \(server.name)"
        case .cancel: "Cancel \(server.name) sign-in"
        case .checkAgain: "Check \(server.name) again"
        }
    }
}
