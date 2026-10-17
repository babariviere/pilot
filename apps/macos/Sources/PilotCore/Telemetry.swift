import Foundation

public struct TelemetrySettings: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let hostKind: TelemetryHostKind
    public let hostId: String
    public let localDiagnostics: Bool
    public let remoteOperational: Bool
    public let productAnalytics: Bool
    public let analyticsId: String?
    public let endpoint: String?
    public let updatedAt: String?

    public init(schemaVersion: Int = 1, hostKind: TelemetryHostKind, hostId: String, localDiagnostics: Bool,
                remoteOperational: Bool, productAnalytics: Bool, endpoint: String? = nil,
                analyticsId: String? = nil, updatedAt: String? = nil) {
        self.schemaVersion = schemaVersion
        self.hostKind = hostKind
        self.hostId = hostId
        self.localDiagnostics = localDiagnostics
        self.remoteOperational = remoteOperational
        self.productAnalytics = productAnalytics
        self.analyticsId = analyticsId
        self.endpoint = endpoint
        self.updatedAt = updatedAt
    }
}

public enum TelemetryHostKind: String, Codable, Sendable { case local, devbox }

public struct TelemetrySettingsPatch: Codable, Equatable, Sendable {
    public let localDiagnostics: Bool
    public let remoteOperational: Bool
    public let productAnalytics: Bool
    public let endpoint: String?

    public init(localDiagnostics: Bool, remoteOperational: Bool, productAnalytics: Bool, endpoint: String? = nil) {
        self.localDiagnostics = localDiagnostics
        self.remoteOperational = remoteOperational
        self.productAnalytics = productAnalytics
        self.endpoint = endpoint
    }
}

public struct TelemetryClearResponse: Codable, Equatable, Sendable { public let cleared: Bool }
