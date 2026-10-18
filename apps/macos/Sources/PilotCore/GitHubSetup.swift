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
    public static func read(host: HostRef, configuration: SSHConnectionConfiguration?) async throws -> String {
        let data: Data
        if let configuration {
            data = try await LinuxBootstrapSSH.run(arguments: arguments(configuration: configuration),
                input: URL(fileURLWithPath: "/dev/null"), timeout: 20)
        } else {
            let environment = ProcessInfo.processInfo.environment
            let home = environment["PILOT_HOME"].map { URL(fileURLWithPath: $0) }
                ?? URL(fileURLWithPath: environment["XDG_DATA_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share").path).appendingPathComponent("pilot")
            data = try await Task.detached { try Data(contentsOf: home.appendingPathComponent("github-app-capability")) }.value
        }
        return try validate(data, host: host)
    }
    static func validate(_ data: Data, host: HostRef) throws -> String {
        guard data.count <= 4096 else { throw HostRoutingError.invalidReference }
        let value = try JSONDecoder().decode(Capability.self, from: data)
        guard value.daemonId == host.daemonId, value.lineageId == host.lineageId,
              value.token.utf8.count == 64, value.token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw HostRoutingError.identityChanged }
        return value.token
    }
    static func arguments(configuration: SSHConnectionConfiguration) -> [String] {
        // Runtime bootstrap pins this path. No caller-supplied command, path or shell interpolation.
        let command = "exec python3 -c 'from pathlib import Path; import sys; p=Path.home()/\".local/share/pilot/github-app-capability\"; sys.stdout.buffer.write(p.read_bytes()[:4097])'"
        return SSHArguments.safety.filter { $0 != "-N" } + ["-o", "ControlMaster=no", "-S", "none", "-o", "ClearAllForwardings=yes", "--", configuration.alias, command]
    }
}
