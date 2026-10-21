import Foundation

/// Mirrors github-setup.ts. Tokens and private keys are deliberately absent.
public struct GitHubSetupStatus: Codable, Equatable, Sendable {
    public let phase: String
    public let operationId: String?
    public let account: String?
    public let apiReady: Bool
    public let sshReady: Bool
    public let publicKey: String?
    public let fingerprint: String?
    public let keyId: Int?
    public let challenge: GitHubDeviceChallenge?
    public let problem: String?
    public var working: Bool { ["authorizing", "uploading"].contains(phase) }
}
public struct GitHubDeviceChallenge: Codable, Equatable, Sendable {
    public let url: String
    public let code: String
    public let expiresAt: Double
    public var browserURL: URL? { url == "https://github.com/login/device" ? URL(string: url) : nil }
}
public struct GitHubSetupAction: Codable, Sendable {
    public let id: String
    public let action: String
    public let account: String?
    public let fingerprint: String?
    public init(id: String = UUID().uuidString.lowercased(), action: String, account: String? = nil, fingerprint: String? = nil) {
        self.id = id; self.action = action; self.account = account; self.fingerprint = fingerprint
    }
}

/// A separate app-action capability, never a GitHub credential. Only read after verified host selection.
/// Not cached, logged, persisted in the app, queued, or exposed to tools/messages.
public enum GitHubNativeAccess {
    private struct Capability: Decodable { let daemonId: String; let lineageId: String; let token: String }
    public static func read(host: HostRef) async throws -> String {
        guard host.hostId == "local" else { throw HostRoutingError.invalidReference }
        let environment = ProcessInfo.processInfo.environment
        let home = environment["PILOT_HOME"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: environment["XDG_DATA_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share").path).appendingPathComponent("pilot")
        let data = try await Task.detached { try Data(contentsOf: home.appendingPathComponent("github-app-capability")) }.value
        return try validate(data, host: host)
    }
    static func validate(_ data: Data, host: HostRef) throws -> String {
        guard data.count <= 4096 else { throw HostRoutingError.invalidReference }
        let value = try JSONDecoder().decode(Capability.self, from: data)
        guard value.daemonId == host.daemonId, value.lineageId == host.lineageId,
              value.token.utf8.count == 64, value.token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw HostRoutingError.identityChanged }
        return value.token
    }
}
