import Foundation
import PilotCore

@MainActor struct McpSetupTransport {
    let client: PilotClient
    let token: HostConnectionToken
    let current: () -> Bool
    let capability: () async throws -> String

    func endpoint() -> McpSetupSharing.Endpoint {
        .init(token: token, current: current, read: { try await read() }, apply: { try await apply($0) })
    }

    func read() async throws -> McpSetupSnapshot {
        guard current(), !Task.isCancelled else { throw McpSetupFailure.changed }
        let value = try await capability()
        guard current(), !Task.isCancelled else { throw McpSetupFailure.changed }
        do {
            let snapshot: McpSetupSnapshot = try await client.githubRequest("api/mcp/setup", capability: value,
                body: Optional<McpSetupApplyRequest>.none, method: "GET")
            guard current(), !Task.isCancelled else { throw McpSetupFailure.changed }
            return snapshot
        } catch let error as ClientError {
            if error.status == 404 { throw McpSetupFailure.unsupported }
            throw McpSetupFailure.unavailable
        }
    }

    func apply(_ input: McpSetupApplyRequest) async throws {
        guard current(), !Task.isCancelled, input.entries.allSatisfy({ $0.config.shareable }) else { throw McpSetupFailure.changed }
        let value = try await capability()
        guard current(), !Task.isCancelled else { throw McpSetupFailure.changed }
        do {
            let _: McpSetupSnapshot = try await client.githubRequest("api/mcp/setup", capability: value, body: input, method: "PUT")
            guard current(), !Task.isCancelled else { throw McpSetupFailure.changed }
        } catch let error as ClientError {
            if error.status == 409 { throw McpSetupFailure.conflict }
            if error.status == 422 { throw McpSetupFailure.dependencyMissing }
            if [400, 403].contains(error.status ?? 0) { throw McpSetupFailure.manualSetup }
            throw McpSetupFailure.unavailable
        }
    }
}
