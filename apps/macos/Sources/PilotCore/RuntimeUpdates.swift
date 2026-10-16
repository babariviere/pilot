import Foundation

public enum RuntimeUpdatePhase: String, Codable, Sendable {
    case staged, requested, waiting, draining, ready, stopping, switching, validating, completed, cancelled
    case needsRepair = "needs-repair"
}
public struct RuntimeUpdateStatus: Codable, Sendable, Identifiable {
    public struct Blocker: Codable, Sendable {
        public let kind: String
        public let id: String
        public let sessionId: String?
    }
    public let id: String
    public let version: String
    public let phase: RuntimeUpdatePhase
    public let requestConfirmed: Bool
    public let revision: Int
    public let blockers: [Blocker]
    public let detail: String?
}
public struct RuntimeProcessIdentity: Codable, Sendable {
    public let bootId: String
    public let pid: Int
    public let start: String
}
public struct RuntimeUpdateCancellation: Codable, Sendable {
    public let id: String
    public let requested: Bool
}

/// Explicit update action. Persist id before calling; ambiguous SSH delivery reconciles that same id.
/// App cancellation only closes its SSH process. The remote systemd owner continues independently.
public enum LinuxSSHUpdate {
    public static func start(configuration: SSHConnectionConfiguration, package: LinuxRuntimePackage,
                             host: HostRef, id: UUID) async throws -> String {
        guard configuration.remotePort == 4319 else { throw HostRoutingError.invalidReference }
        try await Task.detached { try package.manifest.verifyArchive(at: package.archiveURL) }.value
        try Task.checkCancellation()
        let args = try commandArguments(configuration: configuration, package: package, host: host, id: id,
                                        script: LinuxSSHBootstrap.scriptSource())
        let data = try await LinuxBootstrapSSH.run(arguments: args, input: package.archiveURL)
        struct Report: Decodable { let ok: Bool; let id: String?; let requestConfirmed: Bool?; let code: String?; let detail: String?; let plan: JSONValue? }
        guard let result = try? JSONDecoder().decode(Report.self, from: data) else {
            throw LinuxBootstrapFailure("update", "The update request has no confirmed reply. Reconnect and check the same update before trying again.")
        }
        guard result.ok else {
            throw LinuxBootstrapFailure(result.code ?? "update", result.detail ?? "Check this update after reconnecting.", plan: result.plan)
        }
        guard result.id == id.uuidString.lowercased() else { throw HostRoutingError.identityChanged }
        guard result.requestConfirmed == true else {
            throw LinuxBootstrapFailure("update", "The package may be staged, but the update request is not confirmed. Reconnect and retry the same update ID; do not start another update.")
        }
        return id.uuidString.lowercased()
    }
    static func commandArguments(configuration: SSHConnectionConfiguration, package: LinuxRuntimePackage,
                                 host: HostRef, id: UUID, script: String) throws -> [String] {
        let request: [String: String] = ["id": id.uuidString.lowercased(), "daemonId": host.daemonId,
            "lineageId": host.lineageId, "version": package.manifest.version,
            "archive": package.manifest.archive.sha256, "manifest": package.manifestBytes.base64EncodedString(),
            "signature": package.signature.base64EncodedString(), "publicKey": package.publicKey.base64EncodedString()]
        let encoded = try JSONEncoder().encode(request).base64EncodedString()
        var args = try LinuxSSHBootstrap.commandArguments(configuration: configuration, package: package,
                                                         pinnedHost: host, script: script)
        // The original helper command has one fixed, safely quoted JSON pin argument. Append a separate mode
        // and base64 metadata argument; no release URL, GitHub token or credential crosses SSH.
        args[args.count - 1] += " update '" + encoded + "'"
        return args
    }
}
