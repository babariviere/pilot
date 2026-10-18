import Foundation

public enum AIUsageBudgetBasis: String, Codable, CaseIterable, Hashable, Sendable {
    case catalogEstimate = "catalog_estimate"
    case billed
}

public enum AIUsageBudgetWindow: String, Codable, Sendable {
    case retainedChat = "retained_chat"
}

public struct AIUsageBudget: Codable, Equatable, Sendable {
    public let basis: AIUsageBudgetBasis
    public let limitUsdMicros: Double
    public let window: AIUsageBudgetWindow

    public init(basis: AIUsageBudgetBasis, limitUsdMicros: Double,
                window: AIUsageBudgetWindow = .retainedChat) {
        self.basis = basis
        self.limitUsdMicros = limitUsdMicros
        self.window = window
    }
}

public struct AIUsageBudgetComparison: Codable, Equatable, Sendable {
    public let basis: AIUsageBudgetBasis
    public let limitUsdMicros: Double
    public let window: AIUsageBudgetWindow
    public let comparison: String
    public let observedUsdMicros: Double?
    public let coverage: String
    public let subscriptionCoverage: String
    public let informational: Bool
}

public struct TelemetrySettings: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let hostKind: TelemetryHostKind
    public let hostId: String
    public let localDiagnostics: Bool
    public let remoteOperational: Bool
    public let productAnalytics: Bool
    public let analyticsId: String?
    public let endpoint: String?
    public let aiUsageBudget: AIUsageBudget?
    public let updatedAt: String?

    public init(schemaVersion: Int = 1, hostKind: TelemetryHostKind, hostId: String, localDiagnostics: Bool,
                remoteOperational: Bool, productAnalytics: Bool, endpoint: String? = nil,
                analyticsId: String? = nil, aiUsageBudget: AIUsageBudget? = nil, updatedAt: String? = nil) {
        self.schemaVersion = schemaVersion
        self.hostKind = hostKind
        self.hostId = hostId
        self.localDiagnostics = localDiagnostics
        self.remoteOperational = remoteOperational
        self.productAnalytics = productAnalytics
        self.analyticsId = analyticsId
        self.endpoint = endpoint
        self.aiUsageBudget = aiUsageBudget
        self.updatedAt = updatedAt
    }
}

public enum TelemetryHostKind: String, Codable, Sendable { case local, devbox }

public struct TelemetrySettingsPatch: Codable, Equatable, Sendable {
    public let localDiagnostics: Bool
    public let remoteOperational: Bool
    public let productAnalytics: Bool
    public let endpoint: String?
    public let aiUsageBudget: AIUsageBudget?

    private enum CodingKeys: String, CodingKey {
        case localDiagnostics, remoteOperational, productAnalytics, endpoint, aiUsageBudget
    }

    public init(localDiagnostics: Bool, remoteOperational: Bool, productAnalytics: Bool, endpoint: String? = nil,
                aiUsageBudget: AIUsageBudget? = nil) {
        self.localDiagnostics = localDiagnostics
        self.remoteOperational = remoteOperational
        self.productAnalytics = productAnalytics
        self.endpoint = endpoint
        self.aiUsageBudget = aiUsageBudget
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(localDiagnostics, forKey: .localDiagnostics)
        try container.encode(remoteOperational, forKey: .remoteOperational)
        try container.encode(productAnalytics, forKey: .productAnalytics)
        try container.encodeIfPresent(endpoint, forKey: .endpoint)
        if let aiUsageBudget {
            try container.encode(aiUsageBudget, forKey: .aiUsageBudget)
        } else {
            try container.encodeNil(forKey: .aiUsageBudget)
        }
    }
}

public struct TelemetryClearResponse: Codable, Equatable, Sendable { public let cleared: Bool }
