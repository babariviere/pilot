import Foundation

/// The user's global pi MCP servers as pilotd last found them. Mirrors `packages/protocol/src/mcp.ts`.
public enum McpServerState: String, LenientStringEnum {
    case connected
    case needsSignIn = "needs_sign_in"
    case failed, unknown, disabled
    public static let fallback = McpServerState.unknown

    /// The server keeps chats from using it until the user acts.
    public var needsUser: Bool { self == .needsSignIn || self == .failed }
}

public struct McpSignInState: Codable, Equatable, Sendable {
    public let state: SourceSignIn.State
    public let again: Bool?
    public let startedAt: Double
    public let expiresAt: Double
    public let finishedAt: Double?
    public let error: String?
    public init(state: SourceSignIn.State, again: Bool? = nil, startedAt: Double, expiresAt: Double,
                finishedAt: Double? = nil, error: String? = nil) {
        self.state = state; self.again = again; self.startedAt = startedAt; self.expiresAt = expiresAt
        self.finishedAt = finishedAt; self.error = error
    }
}

public struct McpServerStatus: Codable, Equatable, Identifiable, Sendable {
    public enum Transport: String, LenientStringEnum {
        case stdio, http
        public static let fallback = Transport.stdio
    }
    public let name: String
    public let transport: Transport
    public let state: McpServerState
    public let tools: Int?
    public let problem: String?
    public let canSignIn: Bool?
    public let checkedAt: Double?
    public let signIn: McpSignInState?
    public var id: String { name }
    public init(name: String, transport: Transport, state: McpServerState, tools: Int? = nil, problem: String? = nil,
                canSignIn: Bool? = nil, checkedAt: Double? = nil, signIn: McpSignInState? = nil) {
        self.name = name; self.transport = transport; self.state = state; self.tools = tools
        self.problem = problem; self.canSignIn = canSignIn; self.checkedAt = checkedAt; self.signIn = signIn
    }
}

public struct McpStatus: Codable, Equatable, Sendable {
    public let servers: [McpServerStatus]
    public let checking: Bool
    public let configProblems: Int?
    public init(servers: [McpServerStatus], checking: Bool = false, configProblems: Int? = nil) {
        self.servers = servers; self.checking = checking; self.configProblems = configProblems
    }

    /// Servers that keep chats from using them until the user acts.
    public var needingUser: [McpServerStatus] { servers.filter { $0.state.needsUser } }

    public func server(named name: String) -> McpServerStatus? { servers.first { $0.name == name } }
}

public struct McpCheckRequest: Codable, Equatable, Sendable {
    public let server: String?
    public init(server: String? = nil) { self.server = server }
}

public struct McpSignInRequest: Codable, Equatable, Sendable {
    public let again: Bool
    public init(again: Bool) { self.again = again }
}

/// Plain-language state for a server row.
public enum McpStatusText {
    public static func line(_ server: McpServerStatus) -> String {
        if server.signIn?.state == .waiting { return "Waiting for sign-in in your browser…" }
        switch server.state {
        case .connected:
            guard let tools = server.tools else { return "Connected" }
            return "Connected · \(tools) \(tools == 1 ? "tool" : "tools")"
        case .needsSignIn:
            return server.canSignIn == true ? "Needs sign-in" : "Needs sign-in · run pi mcp login \(server.name)"
        case .failed: return server.problem ?? "Couldn't connect."
        case .unknown: return server.problem ?? "Pilot can't check this server."
        case .disabled: return "Turned off in pi"
        }
    }

    /// A failed sign-in, while it still matters.
    public static func signInProblem(_ server: McpServerStatus) -> String? {
        guard let signIn = server.signIn, signIn.state == .failed, server.state != .connected else { return nil }
        return signIn.error ?? "Sign-in didn't finish. Try again."
    }

    /// The outcome of a check the user asked for, shown beside Check Now once it finishes.
    public static func checkResult(_ status: McpStatus) -> (text: String, attention: Bool) {
        let needing = status.needingUser.count
        if needing > 0 { return ("\(needing) \(needing == 1 ? "server needs" : "servers need") you", true) }
        let checked = status.servers.filter { $0.state != .disabled }
        if checked.isEmpty { return ("No servers to check", false) }
        let connected = checked.filter { $0.state == .connected }.count
        if connected == checked.count {
            return (connected == 1 ? "Connected" : "All \(connected) connected", false)
        }
        return ("\(connected) of \(checked.count) connected", false)
    }
}
