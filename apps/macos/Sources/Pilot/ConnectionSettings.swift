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
            SettingsSection("MCP servers", explanation: status.servers.isEmpty
                ? "Add servers with pi mcp add or in ~/.pi/agent/mcp.json. Pilot checks again when that file changes."
                : "From ~/.pi/agent/mcp.json. Pilot checks them when it starts and whenever pi's MCP files change, including a sign-in from a terminal. Run pi mcp list for full errors.") {
                if status.servers.isEmpty {
                    SettingsRow {
                        Text(status.checking ? "Checking MCP servers…" : "pi has no MCP servers yet.")
                            .font(.pilot(.label))
                            .foregroundStyle(Theme.mutedForeground)
                    }
                } else {
                    ForEach(status.servers) { server in McpServerRow(server: server) }
                }
            }
            if let count = status.configProblems, count > 0 {
                SettingsSection {
                    SettingsRow {
                        InlineProblem("\(count) \(count == 1 ? "entry" : "entries") in mcp.json \(count == 1 ? "is" : "are") invalid. Run pi mcp list for details.")
                    }
                }
            }
        } else {
            SettingsSection {
                SettingsRow { ProgressView("Checking MCP servers…").controlSize(.small) }
            }
        }
        if let error {
            SettingsSection {
                SettingsRow { InlineProblem(error) }
            }
        }
    }
}

/// The count on the Connections sidebar row: servers that need the user. Only this badge observes MCP status.
struct ConnectionsTabBadge: View {
    @ObservedObject private var store = AppModel.shared.client.mcp

    var body: some View {
        let count = store.needingUser.count
        if count > 0 {
            CountBadge(count: count, style: .attention)
                .padding(.trailing, 6)
                .help("\(count) \(count == 1 ? "server needs" : "servers need") you")
                .accessibilityLabel("\(count) \(count == 1 ? "server needs" : "servers need") you")
        }
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
        SettingsRow {
            VStack(alignment: .leading, spacing: 2) {
                Text(server.name).font(.pilot(.body)).foregroundStyle(Theme.foreground)
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
        } control: {
            HStack(spacing: 6) {
                if text.waiting { ProgressView().controlSize(.small) }
                McpServerAction(server: server)
            }
        }
        .contentShape(Rectangle())
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

    enum AttentionAction: Equatable { case signIn, cancel, openSettings }

    /// What a chat blocked on a server offers: pi's browser sign-in when the server uses it, otherwise
    /// Settings › Connections, which says what to run.
    static func attentionAction(_ server: McpServerStatus?) -> AttentionAction {
        guard let server else { return .openSettings }
        if server.signIn?.state == .waiting { return .cancel }
        return server.canSignIn == true && server.state == .needsSignIn ? .signIn : .openSettings
    }

    static func title(_ action: AttentionAction) -> String {
        switch action {
        case .signIn: "Sign in"
        case .cancel: "Cancel"
        case .openSettings: "Open Connections"
        }
    }
}

extension PilotClient {
    /// Runs a chat's MCP attention action. Opening settings is left to the caller's environment.
    func performMcpAttention(_ action: McpServerRowText.AttentionAction, server: String?,
                             openSettings: () -> Void) async {
        switch action {
        case .signIn: if let server { await startMcpSignIn(server) }
        case .cancel: if let server { await cancelMcpSignIn(server) }
        case .openSettings:
            AppModel.shared.settingsTab = .connections
            openSettings()
        }
    }
}

/// One quiet line above the composer while this chat waits on an MCP server, with its one action.
/// Clears once the server works again or the user writes in the chat.
struct McpChatNotice: View {
    let reason: NeedsYouReason
    @ObservedObject private var store = AppModel.shared.client.mcp
    @Environment(\.openSettings) private var openSettings
    @State private var busy = false

    var body: some View {
        let server = reason.server.flatMap { store.status?.server(named: $0) }
        let action = McpServerRowText.attentionAction(server)
        let waiting = action == .cancel
        HStack(spacing: 6) {
            PilotSymbol(PilotIcon.signInRequired).foregroundStyle(Theme.blocked).accessibilityHidden(true)
            Text(waiting ? "Waiting for sign-in in your browser…" : reason.detail ?? "An MCP server needs you")
                .foregroundStyle(Theme.mutedForeground)
                .lineLimit(1)
            Spacer(minLength: 8)
            if waiting { ProgressView().controlSize(.small) }
            Button(McpServerRowText.title(action)) {
                busy = true
                Task {
                    defer { busy = false }
                    await AppModel.shared.client.performMcpAttention(action, server: reason.server) { openSettings() }
                }
            }
            .buttonStyle(.link)
            .disabled(busy)
            .help(action == .signIn ? "Opens your browser to sign in. The chat picks it up on its next turn."
                : action == .cancel ? "Stop waiting for the browser" : "See MCP servers and what they need")
        }
        .font(.pilot(.caption))
        .accessibilityElement(children: .contain)
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
