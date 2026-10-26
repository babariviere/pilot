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
    /// Project environment setup. Absent on older runtimes and while the feature is off.
    public let environmentSetup: Int?
    public let usageQueries: Int?
    /// Existing-chat conversion has atomic unassigned-source admission. Absent on older runtimes.
    public let guardedMissionConversion: Bool?
    public let passiveMissionLifecycle: Bool?

    public var supportsEnvironmentSetup: Bool { environmentSetup == 1 }
}
