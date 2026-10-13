import Foundation

// Mirrors packages/protocol/src/tracking.ts.
public enum TrackedKind: String, Codable, Hashable, Sendable { case linear, slack }
public struct LinearCycleSummary: Codable, Equatable, Sendable {
    public let id: String
    public let name: String?
    public let number: Int
    public let startsAt: String
    public let endsAt: String
    /// Progress and counts cover only my issues.
    public let progress: Double
    public let total: Int
    public let done: Int
    public let inProgress: Int
    public let todo: Int
}
public struct LinearSourceSummary: Codable, Equatable, Sendable {
    public enum CycleStatus: String, Codable, Sendable { case current, noActiveCycle = "no_active_cycle" }
    public let cycleStatus: CycleStatus
    public let currentCycle: LinearCycleSummary?
    public let statusMessage: String?
}
/// Transient, quoted external content. Starting work always requires user confirmation.
public struct TrackedItemPrefill: Codable, Equatable, Sendable {
    public let itemId: String
    public let identifier: String
    public let title: String
    public let url: String
    public let description: String
    public let gitBranchName: String?
    public let prompt: String
}
public struct ProjectTrackingConfig: Codable, Equatable, Hashable, Sendable {
    public var slackChannels: [String]
    public var linearTeam: String?
    public init(slackChannels: [String] = [], linearTeam: String? = nil) {
        self.slackChannels = slackChannels; self.linearTeam = linearTeam
    }
}
public struct TrackedItem: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let projectId: String
    public let kind: TrackedKind
    public let externalId: String
    public let title: String
    public let url: String
    public let status: String
    public let metadata: [String: JSONValue]
    public let dismissed: Bool
    public let sessionId: String?
    public let missionId: String?
    public let createdAt: Double
    public let updatedAt: Double
    public init(id: String, projectId: String, kind: TrackedKind, externalId: String, title: String, url: String,
                status: String, metadata: [String: JSONValue] = [:], dismissed: Bool = false,
                sessionId: String? = nil, missionId: String? = nil, createdAt: Double, updatedAt: Double) {
        self.id = id; self.projectId = projectId; self.kind = kind; self.externalId = externalId
        self.title = title; self.url = url; self.status = status; self.metadata = metadata; self.dismissed = dismissed
        self.sessionId = sessionId; self.missionId = missionId; self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}
public struct TrackedItemList: Codable, Equatable, Sendable {
    public let items: [TrackedItem]
    public let total: Int
    public init(items: [TrackedItem], total: Int) { self.items = items; self.total = total }
}
public struct TrackedItemPatch: Encodable, Sendable {
    public var dismissed: Bool?
    public var sessionId: String?
    public var missionId: String?
    public var clearSession: Bool
    public var clearMission: Bool
    public init(dismissed: Bool? = nil, sessionId: String? = nil, missionId: String? = nil,
                clearSession: Bool = false, clearMission: Bool = false) {
        self.dismissed = dismissed; self.sessionId = sessionId; self.missionId = missionId
        self.clearSession = clearSession; self.clearMission = clearMission
    }
    enum CodingKeys: String, CodingKey { case dismissed, sessionId, missionId }
    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(dismissed, forKey: .dismissed)
        if clearSession { try values.encodeNil(forKey: .sessionId) }
        else { try values.encodeIfPresent(sessionId, forKey: .sessionId) }
        if clearMission { try values.encodeNil(forKey: .missionId) }
        else { try values.encodeIfPresent(missionId, forKey: .missionId) }
    }
}
public struct TrackingSource: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let projectId: String
    public let kind: TrackedKind
    public let label: String
    public let configured: Bool
    public let status: DashboardSourceStatus
    public let lastPolledAt: Double?
    public let error: String?
    public let signInCommand: String?
    public let nextPollAt: Double?
    public let linear: LinearSourceSummary?
    public init(id: String, projectId: String, kind: TrackedKind, label: String, configured: Bool,
                status: DashboardSourceStatus, lastPolledAt: Double? = nil,
                error: String? = nil, signInCommand: String? = nil,
                nextPollAt: Double? = nil, linear: LinearSourceSummary? = nil) {
        self.id = id; self.projectId = projectId; self.kind = kind; self.label = label; self.configured = configured
        self.status = status; self.lastPolledAt = lastPolledAt; self.error = error
        self.signInCommand = signInCommand
        self.nextPollAt = nextPollAt; self.linear = linear
    }
}
