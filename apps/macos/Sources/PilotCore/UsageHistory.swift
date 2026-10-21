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
    public init(provider: String, model: String) { self.provider = provider; self.model = model }
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
    public init(homeId: String, lineageId: String, missionId: String) {
        self.homeId = homeId; self.lineageId = lineageId; self.missionId = missionId
    }
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
    public let filters: UsageQueryFilters?
    public init(kind: String, from: Double, to: Double, limit: Int? = nil,
                after: String? = nil, filters: UsageQueryFilters? = nil) {
        self.kind = kind; self.from = from; self.to = to; self.limit = limit
        self.after = after; self.filters = filters
    }
}

public struct UsageHistoryPage: Codable, Equatable, Hashable, Sendable {
    public let rows: [UsageObservation]
    public let next: String?
    public let status: UsageHistoryStatus
}

public struct UsageQueryFilters: Codable, Equatable, Hashable, Sendable {
    public var projectId: String?
    public var chatId: String?
    public var mission: UsageHistoryMission?
    public var purpose: String?
    public var physicalModel: UsageHistoryModel?
    public var virtualModel: UsageHistoryModel?
    public var virtualRevision: String?
    public var missing: [String]?
    public init(projectId: String? = nil, chatId: String? = nil, mission: UsageHistoryMission? = nil,
                purpose: String? = nil, physicalModel: UsageHistoryModel? = nil,
                virtualModel: UsageHistoryModel? = nil, virtualRevision: String? = nil, missing: [String]? = nil) {
        self.projectId = projectId; self.chatId = chatId; self.mission = mission; self.purpose = purpose
        self.physicalModel = physicalModel; self.virtualModel = virtualModel; self.virtualRevision = virtualRevision
        self.missing = missing
    }
}

public struct UsageAnalyticsQuery: Codable, Equatable, Hashable, Sendable {
    public let version: Int
    public let from: Double
    public let to: Double
    public let filters: UsageQueryFilters?
    public let view: String
    public let dimension: String?
    public let bucketMs: Int?
    public let limit: Int?
    public let after: String?
    public init(from: Double, to: Double, filters: UsageQueryFilters? = nil, view: String = "summary",
                dimension: String? = nil, bucketMs: Int? = nil, limit: Int? = nil, after: String? = nil) {
        version = 1; self.from = from; self.to = to; self.filters = filters; self.view = view
        self.dimension = dimension; self.bucketMs = bucketMs; self.limit = limit; self.after = after
    }
}

public struct UsageMetric: Codable, Equatable, Hashable, Sendable {
    public let value: Double?
    public let known: Int
    public let unknown: Int
    public let partial: Int
    public let overflow: Bool
}

public struct UsageAggregate: Codable, Equatable, Hashable, Sendable {
    public let records: Int
    public let committed: Int
    public let partial: Int
    public let legacy: Int
    public let unpriced: Int
    public let partialPriced: Int
    public let pricingVersions: Int
    public let pricingRevision: String?
    public let metrics: [String: UsageMetric]
}

public struct UsageAnalyticsGroup: Codable, Equatable, Hashable, Sendable {
    public let key: String
    public let aggregate: UsageAggregate
}

public struct UsageAnalyticsResult: Codable, Equatable, Hashable, Sendable {
    public let version: Int
    public let queriedAt: Double
    public let status: UsageHistoryStatus
    public let total: UsageAggregate
    /// Non-additive coverage only. Never sum with total or allocate to chart dates.
    public let reconciliation: UsageAggregate
    public let groups: [UsageAnalyticsGroup]
    public let next: String?
    public let truncated: Bool
    public let coverage: String
}

public struct UsageHostProjection: Codable, Equatable, Sendable {
    public let host: HostRef
    public let state: String
    public let result: UsageAnalyticsResult?
    public init(host: HostRef, state: String, result: UsageAnalyticsResult? = nil) {
        self.host = host; self.state = state; self.result = result
    }
}

public struct UsageConnectedProjection: Codable, Equatable, Sendable {
    public let hosts: [UsageHostProjection]
    public let omittedHosts: Int
    public let queriedAt: Double
    public let coverage: String
    public init(hosts: [UsageHostProjection], omittedHosts: Int, queriedAt: Double) {
        self.hosts = hosts; self.omittedHosts = omittedHosts; self.queriedAt = queriedAt; coverage = "partial"
    }
}

/// Plan from existing endpoints only. Canonical daemon/lineage wins over enrollment aliases.
/// Choosing one connected alias is not execution failover; failed reads are never retried on another.
public struct UsageProjectionPlan: Sendable {
    public let hosts: [UsageHostProjection]
    public let omittedHosts: Int
    public init(hosts: [HostRef], connected: Set<HostRef>) {
        let ordered = Set(hosts).sorted {
            if connected.contains($0) != connected.contains($1) { return connected.contains($0) }
            return [$0.daemonId, $0.lineageId, $0.hostId].lexicographicallyPrecedes([$1.daemonId, $1.lineageId, $1.hostId])
        }
        var seen: Set<[String]> = []
        self.hosts = ordered.prefix(32).map { host in
            let identity = [host.daemonId.lowercased(), host.lineageId.lowercased()]
            let first = seen.insert(identity).inserted
            return UsageHostProjection(host: host, state: !first ? "alias" : connected.contains(host) ? "fresh" : "disconnected")
        }
        omittedHosts = max(0, ordered.count - 32)
    }
}
