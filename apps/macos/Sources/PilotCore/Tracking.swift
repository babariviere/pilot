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
    public init(id: String, name: String? = nil, number: Int, startsAt: String, endsAt: String, progress: Double,
                total: Int, done: Int, inProgress: Int, todo: Int) {
        self.id = id; self.name = name; self.number = number; self.startsAt = startsAt; self.endsAt = endsAt
        self.progress = progress; self.total = total; self.done = done; self.inProgress = inProgress; self.todo = todo
    }
}
public struct LinearSourceSummary: Codable, Equatable, Sendable {
    public enum CycleStatus: String, Codable, Sendable { case current, noActiveCycle = "no_active_cycle" }
    public let cycleStatus: CycleStatus
    public let currentCycle: LinearCycleSummary?
    public let statusMessage: String?
    public init(cycleStatus: CycleStatus, currentCycle: LinearCycleSummary? = nil, statusMessage: String? = nil) {
        self.cycleStatus = cycleStatus; self.currentCycle = currentCycle; self.statusMessage = statusMessage
    }
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
    public init(itemId: String, identifier: String, title: String, url: String, description: String,
                gitBranchName: String? = nil, prompt: String) {
        self.itemId = itemId; self.identifier = identifier; self.title = title; self.url = url
        self.description = description; self.gitBranchName = gitBranchName; self.prompt = prompt
    }
}
public struct ProjectTrackingConfig: Codable, Equatable, Hashable, Sendable {
    /// Channel IDs from the picker. Older configs may hold names.
    public var slackChannels: [String]
    /// Display names by channel ID. Never part of the poll scope.
    public var slackChannelNames: [String: String]?
    /// Team ID from list_teams. An empty string in a request clears the team.
    public var linearTeam: String?
    public var linearTeamName: String?
    public init(slackChannels: [String] = [], slackChannelNames: [String: String]? = nil,
                linearTeam: String? = nil, linearTeamName: String? = nil) {
        self.slackChannels = slackChannels; self.slackChannelNames = slackChannelNames
        self.linearTeam = linearTeam; self.linearTeamName = linearTeamName
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
    /// Latest bound chat and mission.
    public let sessionId: String?
    public let missionId: String?
    /// Every bound chat and mission, oldest first.
    public let sessionIds: [String]?
    public let missionIds: [String]?
    public let createdAt: Double
    public let updatedAt: Double
    public init(id: String, projectId: String, kind: TrackedKind, externalId: String, title: String, url: String,
                status: String, metadata: [String: JSONValue] = [:], dismissed: Bool = false,
                sessionId: String? = nil, missionId: String? = nil, sessionIds: [String]? = nil,
                missionIds: [String]? = nil, createdAt: Double, updatedAt: Double) {
        self.id = id; self.projectId = projectId; self.kind = kind; self.externalId = externalId
        self.title = title; self.url = url; self.status = status; self.metadata = metadata; self.dismissed = dismissed
        self.sessionId = sessionId; self.missionId = missionId; self.createdAt = createdAt; self.updatedAt = updatedAt
        self.sessionIds = sessionIds ?? sessionId.map { [$0] }
        self.missionIds = missionIds ?? missionId.map { [$0] }
    }

    /// A project dashboard row as a full item, so pages reuse the tracked row and its actions.
    /// Dashboard rows are never dismissed; fields the dashboard omits read as empty.
    public init(dashboard row: DashboardTrackedItem, projectId: String, kind: TrackedKind) {
        self.init(id: row.id, projectId: projectId, kind: kind, externalId: row.externalId ?? row.id,
                  title: row.title, url: row.url ?? "", status: row.status ?? "", metadata: row.metadata ?? [:],
                  sessionId: row.sessionId, missionId: row.missionId, sessionIds: row.sessionIds,
                  missionIds: row.missionIds, createdAt: row.updatedAt ?? 0, updatedAt: row.updatedAt ?? 0)
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
/// Per-channel health of a configured Slack channel.
public struct SlackChannelStatus: Codable, Equatable, Sendable {
    public enum Status: String, LenientStringEnum {
        case pending, ok, error
        case signInRequired = "sign_in_required"
        public static let fallback = Status.error
    }
    public let id: String
    public let name: String?
    public let status: Status
    public let lastPulledAt: Double?
    public let error: String?
    public init(id: String, name: String? = nil, status: Status, lastPulledAt: Double? = nil, error: String? = nil) {
        self.id = id; self.name = name; self.status = status; self.lastPulledAt = lastPulledAt; self.error = error
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
    /// Slack only, in configuration order.
    public let channels: [SlackChannelStatus]?
    /// Latest browser sign-in to this kind's MCP server, shared by every project.
    public let signIn: SourceSignIn?
    public init(id: String, projectId: String, kind: TrackedKind, label: String, configured: Bool,
                status: DashboardSourceStatus, lastPolledAt: Double? = nil,
                error: String? = nil, signInCommand: String? = nil,
                nextPollAt: Double? = nil, linear: LinearSourceSummary? = nil, channels: [SlackChannelStatus]? = nil,
                signIn: SourceSignIn? = nil) {
        self.id = id; self.projectId = projectId; self.kind = kind; self.label = label; self.configured = configured
        self.status = status; self.lastPolledAt = lastPolledAt; self.error = error
        self.signInCommand = signInCommand
        self.nextPollAt = nextPollAt; self.linear = linear; self.channels = channels; self.signIn = signIn
    }
}
/// Browser sign-in to a tracking source's MCP server, run by pilotd through pi's OAuth flow.
/// Tokens stay in pi's credential file; the app only sees the state.
public struct SourceSignIn: Codable, Equatable, Sendable {
    public enum State: String, LenientStringEnum {
        case waiting, done, failed, cancelled
        public static let fallback = State.failed
    }
    public let kind: TrackedKind
    public let state: State
    /// Signing in again while signed in (another account or new scope).
    public let again: Bool?
    public let startedAt: Double
    public let expiresAt: Double
    public let finishedAt: Double?
    public let error: String?
    public init(kind: TrackedKind, state: State, again: Bool? = nil, startedAt: Double, expiresAt: Double,
                finishedAt: Double? = nil, error: String? = nil) {
        self.kind = kind; self.state = state; self.again = again; self.startedAt = startedAt
        self.expiresAt = expiresAt; self.finishedAt = finishedAt; self.error = error
    }
}
public struct SourceSignInRequest: Codable, Equatable, Sendable {
    public let again: Bool
    public init(again: Bool) { self.again = again }
}
/// A Linear team for the project settings picker.
public struct LinearTeamOption: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let key: String
    public let parentId: String?
    public init(id: String, name: String, key: String, parentId: String? = nil) {
        self.id = id; self.name = name; self.key = key; self.parentId = parentId
    }
}
/// A Slack channel for the project settings picker.
public struct SlackChannelOption: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let isPrivate: Bool
    enum CodingKeys: String, CodingKey { case id, name, isPrivate = "private" }
    public init(id: String, name: String, isPrivate: Bool = false) {
        self.id = id; self.name = name; self.isPrivate = isPrivate
    }
}
public enum TrackingLookupStatus: String, LenientStringEnum {
    case ok, error
    case signInRequired = "sign_in_required"
    public static let fallback = TrackingLookupStatus.error
}
/// Read-only lookup result. Sign-in and errors are states, not HTTP failures.
public struct TrackingLookup<Item: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public typealias Status = TrackingLookupStatus
    public let status: Status
    public let items: [Item]
    public let more: Bool?
    public let error: String?
    public let signInCommand: String?
    public init(status: Status, items: [Item] = [], more: Bool? = nil, error: String? = nil,
                signInCommand: String? = nil) {
        self.status = status; self.items = items; self.more = more; self.error = error
        self.signInCommand = signInCommand
    }
}
