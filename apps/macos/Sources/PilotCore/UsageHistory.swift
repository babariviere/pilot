import Foundation

/// Private local accounting DTOs. Not diagnostics or remote telemetry payloads.
public struct UsageObservation: Codable, Equatable, Hashable, Sendable {
    public let schemaVersion: Int
    public let generation: String
    public let sourceId: String
    public let operationId: String
    public let revision: Double
    public let kind: String
    public let scope: String
    public let observedAt: Double
    public let completedAt: Double?
    public let coverage: String
    public let purpose: String
    public let attribution: UsageHistoryAttribution?
    public let physicalModel: UsageHistoryModel?
    public let virtualModel: UsageHistoryModel?
    public let virtualRevision: String?
    public let parent: UsageHistoryParent?
    public let tokens: AIUsageTokens?
    public let cost: AIUsageCost?
    public let activity: String?
    public let requests: Double?
    public let providerAttempts: Double?
    public let retries: Double?
    public let durationMs: Double?
    public let outcome: String?
}

public struct UsageHistoryModel: Codable, Equatable, Hashable, Sendable {
    public let provider: String
    public let model: String
}

public struct UsageHistoryAttribution: Codable, Equatable, Hashable, Sendable {
    public let projectId: String?
    public let chatId: String?
    public let attemptId: String?
    public let runId: String?
    public let mission: UsageHistoryMission?
}

public struct UsageHistoryParent: Codable, Equatable, Hashable, Sendable {
    public let sourceId: String
    public let operationId: String
}

public struct UsageHistoryMission: Codable, Equatable, Hashable, Sendable {
    public let homeId: String
    public let lineageId: String
    public let missionId: String
}

public struct UsageHistoryStatus: Codable, Equatable, Hashable, Sendable {
    public let schemaVersion: Int
    public let generation: String
    public let coverageStartedAt: Double
    public let captureFloor: Double
    public let retentionFloor: Double
    public let retainedRows: Double
    public let rejected: Double
    public let conflicts: Double
    public let expired: Double
    public let queueOverflows: Double
    public let coverage: String
}

public struct UsageHistoryQuery: Codable, Equatable, Hashable, Sendable {
    public let kind: String
    public let from: Double
    public let to: Double
    public let limit: Int?
    public let after: String?
}

public struct UsageHistoryPage: Codable, Equatable, Hashable, Sendable {
    public let rows: [UsageObservation]
    public let next: String?
    public let status: UsageHistoryStatus
}
