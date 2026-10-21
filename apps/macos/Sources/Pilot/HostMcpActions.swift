import Combine
import Foundation
import PilotCore

enum HostMcpAction: Equatable { case check, signIn, signInAgain, cancel(startedAt: Double) }

/// One action surface, one immutable host. Remote browser callbacks are not Mac callbacks.
@MainActor final class HostMcpActions: ObservableObject {
    struct Endpoint {
        let token: HostConnectionToken
        let isCurrent: () -> Bool
        let perform: (HostMcpAction, String?) async throws -> Void
    }
    let host: HostRef
    private let endpoint: () throws -> Endpoint
    @Published private(set) var busy = false
    @Published private(set) var problem: String?
    @Published var signInOnHost: String?
    @Published private(set) var signInAgainOnHost = false

    init(host: HostRef, endpoint: @escaping () throws -> Endpoint) { self.host = host; self.endpoint = endpoint }

    func perform(_ action: HostMcpAction, server: String? = nil) async {
        guard !busy else { return }
        guard server == nil || server!.range(of: #"^[A-Za-z0-9_-]{1,200}$"#, options: .regularExpression) != nil else {
            problem = "This server requires manual setup on its host."; return
        }
        var current: (() -> Bool)?
        do {
            let value = try endpoint()
            current = value.isCurrent
            guard value.token.host == host, value.isCurrent() else { throw HostRoutingError.staleGeneration }
            if host.hostId != "local", action == .signIn || action == .signInAgain {
                signInAgainOnHost = action == .signInAgain
                signInOnHost = server; return
            }
            busy = true; problem = nil; defer { busy = false }
            try await value.perform(action, server)
            guard value.isCurrent() else { return }
        } catch {
            guard current?() != false else { return }
            problem = (error as? ClientError)?.status == 404
                ? "This runtime does not support this MCP action. Update it or use Pi on this host directly. Nothing was sent to Local instead."
                : "The action could not be confirmed on this host. Reconnect and check its current state; nothing was sent to Local instead."
        }
    }
}

extension HostMcpActions {
    convenience init(host: HostRef, hosts: ClientDirectory) {
        self.init(host: host) { [weak hosts] in
            guard let hosts else { throw HostRoutingError.disconnected }
            let client = try hosts.endpoint(host), token = try hosts.token(for: host)
            let current = { [weak hosts] in
                guard let hosts else { return false }
                return (try? hosts.validate(token)) != nil
            }
            return Endpoint(token: token, isCurrent: current) { action, server in
                guard current() else { throw HostRoutingError.staleGeneration }
                switch action {
                case .check:
                    let status: McpStatus = try await client.githubRequest("api/mcp/check", capability: "",
                        body: McpCheckRequest(server: server))
                    guard current() else { throw HostRoutingError.staleGeneration }
                    client.mcp.record(status)
                case .signIn, .signInAgain:
                    guard host.hostId == "local", let server else { throw HostRoutingError.invalidReference }
                    let state: McpSignInState = try await client.githubRequest("api/mcp/servers/\(server)/sign-in", capability: "",
                        body: McpSignInRequest(again: action == .signInAgain))
                    guard current() else { throw HostRoutingError.staleGeneration }
                    client.mcp.recordSignIn(server, state)
                case .cancel(let expectedStartedAt):
                    guard let server, let signIn = client.mcp.status?.server(named: server)?.signIn,
                          signIn.state == .waiting, signIn.startedAt == expectedStartedAt else { throw HostRoutingError.staleGeneration }
                    let state: McpSignInState? = try await client.githubRequest("api/mcp/servers/\(server)/sign-in", capability: "",
                        body: McpSignInCancelRequest(expectedStartedAt: expectedStartedAt), method: "DELETE")
                    guard current() else { throw HostRoutingError.staleGeneration }
                    if let state { client.mcp.recordSignIn(server, state) }
                }
            }
        }
    }
}
