import Foundation

/// GET /api/hello. Pin daemonId on pairing and negotiate before streams or mutations.
public struct DaemonHello: Codable, Equatable, Sendable {
    public let daemonId: String
    public let lineageId: String?
    public let daemonVersion: String
    public let protocolVersion: Int
    public let minimumClientProtocolVersion: Int
    public let platform: String
    public let arch: String
    public let capabilities: DaemonCapabilities

    public static let clientProtocolVersion = 1

    public var isProtocolCompatible: Bool {
        minimumClientProtocolVersion > 0
            && minimumClientProtocolVersion <= Self.clientProtocolVersion
            && Self.clientProtocolVersion <= protocolVersion
    }
}

public struct DaemonCapabilities: Codable, Equatable, Sendable {
    public let powerManagement: Bool
    public let systemSleepEvents: Bool
    public let swiftUIArtifacts: Bool
    public let coordinatorIsolation: Bool
    public let independentExecution: Bool
    public let workspaceTerminalProtocol: Int?
    public let runtimeUpdates: Int?
}
