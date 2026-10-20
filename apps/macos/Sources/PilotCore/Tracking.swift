import Foundation

// Mirrors packages/protocol/src/tracking.ts.
public enum TrackedKind: String, Codable, Hashable, Sendable { case linear, slack }

/// The Slack message or Linear ticket a chat was started from or linked to in triage (SessionSummary.trackedSource).
public struct SessionTrackedSource: Codable, Equatable, Hashable, Sendable {
    public let kind: TrackedKind
    /// Tracked item ID, for opening the item in triage.
    public let itemId: String
    /// "#channel" for Slack ("Slack" without a channel name), the ticket identifier for Linear.
    public let label: String
    /// Message or ticket title, at most 200 characters.
    public let title: String
    public let url: String

    public init(kind: TrackedKind, itemId: String, label: String, title: String, url: String) {
        self.kind = kind; self.itemId = itemId; self.label = label; self.title = title; self.url = url
    }

    public var serviceName: String { kind == .slack ? "Slack" : "Linear" }
    /// One line for tooltips and accessibility, e.g. "From Slack #support: Login broken".
    public var summary: String {
        let label = label == serviceName ? serviceName : "\(serviceName) \(label)"
        return title.isEmpty ? "From \(label)" : "From \(label): \(title)"
    }
}
public struct SlackCommonCase: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let count: Int
    public let severityMix: [String: Int]
    public let label: String?
    public let firstSeen: Double
    public let lastSeen: Double
    public enum Trend: String, Codable, Sendable { case rising, steady, fading }
    public let trend: Trend

    public init(id: String, name: String, description: String, count: Int, severityMix: [String: Int] = [:],
                label: String? = nil, firstSeen: Double, lastSeen: Double, trend: Trend = .steady) {
        self.id = id; self.name = name; self.description = description; self.count = count
        self.severityMix = severityMix; self.label = label; self.firstSeen = firstSeen; self.lastSeen = lastSeen
        self.trend = trend
    }
}
public struct SlackCommonCaseList: Codable, Equatable, Sendable {
    public let cases: [SlackCommonCase]
    public let windowDays: Int
    public let windowLimit: Int
    public let truncated: Bool

    public init(cases: [SlackCommonCase], windowDays: Int = 30, windowLimit: Int = 200, truncated: Bool = false) {
        self.cases = cases; self.windowDays = windowDays; self.windowLimit = windowLimit; self.truncated = truncated
    }
}
public struct SlackCaseEdit: Encodable, Sendable {
    public enum Action: String, Encodable, Sendable { case rename, merge, split }
    public let action: Action
    public var name: String?
    public var targetId: String?
    public var itemIds: [String]?
    public init(action: Action, name: String? = nil, targetId: String? = nil, itemIds: [String]? = nil) {
        self.action = action; self.name = name; self.targetId = targetId; self.itemIds = itemIds
    }
}
public enum LinearSize: String, Codable, Hashable, Sendable {
    case quickFix = "quick_fix", needsPlanning = "needs_planning", unknown
}
/// Read-only, untrusted rules rebuilt from corrections. Mirrors TriageGuide.
public struct TriageGuide: Codable, Equatable, Sendable {
    public let kind: TrackedKind
    public let text: String
    public let updatedAt: Double
    public let throughSeq: Int
    public init(kind: TrackedKind, text: String, updatedAt: Double, throughSeq: Int) {
        self.kind = kind; self.text = text; self.updatedAt = updatedAt; self.throughSeq = throughSeq
    }
}
public struct TriageCorrection: Codable, Equatable, Sendable {
    public let itemId: String
    public let summary: String
    public let correctedAt: Double
    public let values: [String: JSONValue]
}
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
    /// Sub-issues: the parent issue, quoted in the prompt as context.
    public let parent: LinearParentRef?
    public let prompt: String
    public init(itemId: String, identifier: String, title: String, url: String, description: String,
                gitBranchName: String? = nil, parent: LinearParentRef? = nil, prompt: String) {
        self.itemId = itemId; self.identifier = identifier; self.title = title; self.url = url
        self.description = description; self.gitBranchName = gitBranchName; self.parent = parent; self.prompt = prompt
    }
}
/// A sub-issue's parent as quoted in a start prompt: identifier and title only.
public struct LinearParentRef: Codable, Equatable, Hashable, Sendable {
    public let identifier: String
    public let title: String
    public init(identifier: String, title: String) { self.identifier = identifier; self.title = title }
}
/// The parent issue of a Linear sub-issue: identity and link only, whether or not the parent is a tracked item.
/// `id` matches the child's `metadata.parentId` and, when the parent is tracked, its `externalId`.
public struct LinearParentHeader: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let identifier: String
    public let title: String
    public let url: String
    public init(id: String, identifier: String, title: String, url: String) {
        self.id = id; self.identifier = identifier; self.title = title; self.url = url
    }
}
/// The first message of a Slack thread, read on demand for the triage inspector. Transient: pilotd never stores it.
/// Plain text, bounded, and empty when the message has no text (for example, only files).
public struct SlackExcerpt: Codable, Equatable, Sendable {
    public let itemId: String
    public let author: String?
    public let text: String
    /// The message was longer and was cut, ending with an ellipsis.
    public let truncated: Bool
    public init(itemId: String, author: String? = nil, text: String, truncated: Bool = false) {
        self.itemId = itemId; self.author = author; self.text = text; self.truncated = truncated
    }
}

/// POST /api/tracking/slack/messages: adds one Slack message, from a pasted link, to a project's triage.
public struct SlackMessageAddRequest: Encodable, Sendable {
    public let projectId: String
    public let url: String
    public init(projectId: String, url: String) { self.projectId = projectId; self.url = url }
}

/// A Slack message link, as from Copy link: https://<workspace>.slack.com/archives/<channel>/p<16 digits>, with
/// thread_ts for a reply. Mirrors pilotd's parseSlackMessageLink, which is authoritative.
public struct SlackMessageLink: Equatable, Sendable {
    public let channel: String
    public let ts: String
    /// The thread's parent, which is what triage tracks.
    public let threadTs: String
    /// The link as pasted, trimmed.
    public let url: String

    public init?(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= 2000, let parts = URLComponents(string: trimmed),
              parts.scheme?.lowercased() == "https", let host = parts.host?.lowercased(),
              host == "slack.com" || host.hasSuffix(".slack.com") else { return nil }
        let path = parts.path.split(separator: "/", omittingEmptySubsequences: true)
        guard path.count == 3, path[0] == "archives", let first = path[1].first, "CDG".contains(first),
              (2 ... 200).contains(path[1].count),
              path[1].allSatisfy({ $0.isASCII && ($0.isUppercase || $0.isNumber) }),
              path[2].first == "p" else { return nil }
        let digits = path[2].dropFirst()
        guard (16 ... 18).contains(digits.count), digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        let ts = "\(digits.dropLast(6)).\(digits.suffix(6))"
        let thread = parts.queryItems?.first { $0.name == "thread_ts" }?.value
        channel = String(path[1])
        self.ts = ts
        threadTs = thread.flatMap { Self.isTimestamp($0) ? $0 : nil } ?? ts
        url = trimmed
    }

    static func isTimestamp(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 2 && (1 ... 12).contains(parts[0].count) && parts[1].count == 6
            && parts.allSatisfy { $0.allSatisfy { $0.isASCII && $0.isNumber } }
    }
}
public enum SlackMessageType: String, Codable, Hashable, Sendable { case bug, question, request, unknown }
public enum SlackSeverity: String, Codable, Hashable, Sendable { case low, medium, high, critical }
public enum SlackLocalStatus: String, Codable, Hashable, Sendable {
    /// waiting: someone outside Pilot must answer in the thread first. A reply from anyone but the user resumes the
    /// linked chat (In progress) or reopens the message (Open).
    case open, inProgress = "in_progress", waiting, done, dismissed
}
/// What a project label does to its Slack messages. none: listed as usual. hide: kept out of the Inbox, behind Show
/// hidden in Slack triage. close: dismissed by Pilot when the label is applied, unless the user set the status, and
/// reopened when the label no longer applies or stops closing.
public enum SlackLabelEffect: String, Codable, CaseIterable, Hashable, Sendable { case none, hide, close }
public struct SlackProjectLabel: Codable, Equatable, Hashable, Sendable {
    public var name: String
    public var description: String
    public var effect: SlackLabelEffect
    public init(name: String, description: String, effect: SlackLabelEffect = .none) {
        self.name = name; self.description = description; self.effect = effect
    }
    enum CodingKeys: String, CodingKey { case name, description, effect, hideFromInbox }
    /// Older daemons sent hideFromInbox: true; an unknown effect reads as none.
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decode(String.self, forKey: .name)
        description = try values.decode(String.self, forKey: .description)
        if let raw = try values.decodeIfPresent(String.self, forKey: .effect) {
            effect = SlackLabelEffect(rawValue: raw) ?? .none
        } else {
            effect = try values.decodeIfPresent(Bool.self, forKey: .hideFromInbox) == true ? .hide : .none
        }
    }
    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(name, forKey: .name)
        try values.encode(description, forKey: .description)
        try values.encode(effect, forKey: .effect)
    }
}
public struct SlackOverrides: Codable, Equatable, Sendable {
    public var type: SlackMessageType?
    public var label: String?
    public var severity: SlackSeverity?
    public var status: SlackLocalStatus?
    /// Explicit null clears a label. Omission preserves the current override.
    public var clearLabel: Bool
    public init(type: SlackMessageType? = nil, label: String? = nil, severity: SlackSeverity? = nil,
                status: SlackLocalStatus? = nil, clearLabel: Bool = false) {
        self.type = type; self.label = label; self.severity = severity; self.status = status; self.clearLabel = clearLabel
    }
    enum CodingKeys: String, CodingKey { case type, label, severity, status }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decodeIfPresent(SlackMessageType.self, forKey: .type)
        label = try values.decodeIfPresent(String.self, forKey: .label)
        severity = try values.decodeIfPresent(SlackSeverity.self, forKey: .severity)
        status = try values.decodeIfPresent(SlackLocalStatus.self, forKey: .status)
        clearLabel = try values.contains(.label) && values.decodeNil(forKey: .label)
    }
    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(type, forKey: .type)
        if clearLabel { try values.encodeNil(forKey: .label) }
        else { try values.encodeIfPresent(label, forKey: .label) }
        try values.encodeIfPresent(severity, forKey: .severity)
        try values.encodeIfPresent(status, forKey: .status)
    }
}
public struct SlackTriage: Codable, Equatable, Sendable {
    public let type: SlackMessageType
    public let label: String?
    public let severity: SlackSeverity
    public let status: SlackLocalStatus
    public let overrides: SlackOverrides
    /// Set while Pilot keeps the message dismissed because of this close label. Any status the user sets clears it.
    public let closedByLabel: String?
    public let doneReason: String?
    /// While waiting: what for, as the agent reported it. Absent when the user set Waiting.
    public let waitingReason: String?
    /// While waiting: epoch ms when the wait started.
    public let waitingSince: Double?
    public init(type: SlackMessageType, label: String? = nil, severity: SlackSeverity, status: SlackLocalStatus,
                overrides: SlackOverrides = .init(), closedByLabel: String? = nil, doneReason: String? = nil,
                waitingReason: String? = nil, waitingSince: Double? = nil) {
        self.type = type; self.label = label; self.severity = severity; self.status = status; self.overrides = overrides
        self.closedByLabel = closedByLabel
        self.doneReason = doneReason
        self.waitingReason = waitingReason
        self.waitingSince = waitingSince
    }
}
public struct SlackCorrection: Codable, Equatable, Sendable {
    public let itemId: String
    public let summary: String
    public let correctedAt: Double
    public let values: SlackOverrides
    public init(itemId: String, summary: String, correctedAt: Double, values: SlackOverrides) {
        self.itemId = itemId; self.summary = summary; self.correctedAt = correctedAt; self.values = values
    }
}
/// A Linear size the user corrected. The summary is the issue title. Mirrors LinearSizeCorrection.
public struct LinearSizeCorrection: Codable, Equatable, Sendable {
    public struct Values: Codable, Equatable, Sendable {
        public let size: LinearSize
        public init(size: LinearSize) { self.size = size }
    }
    public let itemId: String
    public let summary: String
    public let correctedAt: Double
    public let values: Values
    public init(itemId: String, summary: String, correctedAt: Double, size: LinearSize) {
        self.itemId = itemId; self.summary = summary; self.correctedAt = correctedAt; self.values = Values(size: size)
    }
}

public struct ProjectTrackingConfig: Codable, Equatable, Hashable, Sendable {
    /// Channel IDs from the picker. Older configs may hold names.
    public var slackLabels: [SlackProjectLabel]?
    public var slackChannels: [String]
    public var slackMentionOnlyChannels: [String]?
    public var slackGroupHandles: [String]?
    /// Display names by channel ID. Never part of the poll scope.
    public var slackChannelNames: [String: String]?
    /// Team ID from list_teams. An empty string in a request clears the team.
    public var linearTeam: String?
    public var linearTeamName: String?
    /// Workflow mappings by actual issue team, including sub-teams. Only In progress is automated today.
    public var linearStateMappings: [String: LinearStateMapping]?
    public init(slackChannels: [String] = [], slackChannelNames: [String: String]? = nil,
                linearTeam: String? = nil, linearTeamName: String? = nil, slackLabels: [SlackProjectLabel]? = nil,
                linearStateMappings: [String: LinearStateMapping]? = nil,
                slackMentionOnlyChannels: [String]? = nil, slackGroupHandles: [String]? = nil) {
        self.slackChannels = slackChannels; self.slackChannelNames = slackChannelNames
        self.linearTeam = linearTeam; self.linearTeamName = linearTeamName; self.slackLabels = slackLabels
        self.linearStateMappings = linearStateMappings
        self.slackMentionOnlyChannels = slackMentionOnlyChannels; self.slackGroupHandles = slackGroupHandles
    }
}

public struct LinearWorkflowState: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct LinearWorkflowStateOption: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let type: String
    public init(id: String, name: String, type: String) { self.id = id; self.name = name; self.type = type }
    public var reference: LinearWorkflowState { LinearWorkflowState(id: id, name: name) }
}

public enum LinearWorkflowStage: String, CaseIterable, Identifiable, Sendable {
    case todo, inProgress, inReview, merged, deployed, canceled, duplicated
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .todo: "Todo"
        case .inProgress: "In progress"
        case .inReview: "In review"
        case .merged: "Merged"
        case .deployed: "Deployed"
        case .canceled: "Canceled"
        case .duplicated: "Duplicated"
        }
    }
}

public struct LinearStateMapping: Codable, Equatable, Hashable, Sendable {
    public var todo: LinearWorkflowState?
    public var inProgress: LinearWorkflowState?
    public var inReview: LinearWorkflowState?
    public var merged: LinearWorkflowState?
    public var deployed: LinearWorkflowState?
    public var canceled: LinearWorkflowState?
    public var duplicated: LinearWorkflowState?
    public init(todo: LinearWorkflowState? = nil, inProgress: LinearWorkflowState? = nil,
                inReview: LinearWorkflowState? = nil, merged: LinearWorkflowState? = nil,
                deployed: LinearWorkflowState? = nil, canceled: LinearWorkflowState? = nil,
                duplicated: LinearWorkflowState? = nil) {
        self.todo = todo; self.inProgress = inProgress; self.inReview = inReview
        self.merged = merged; self.deployed = deployed
        self.canceled = canceled; self.duplicated = duplicated
    }
    public subscript(stage: LinearWorkflowStage) -> LinearWorkflowState? {
        get {
            switch stage {
            case .todo: todo
            case .inProgress: inProgress
            case .inReview: inReview
            case .merged: merged
            case .deployed: deployed
            case .canceled: canceled
            case .duplicated: duplicated
            }
        }
        set {
            switch stage {
            case .todo: todo = newValue
            case .inProgress: inProgress = newValue
            case .inReview: inReview = newValue
            case .merged: merged = newValue
            case .deployed: deployed = newValue
            case .canceled: canceled = newValue
            case .duplicated: duplicated = newValue
            }
        }
    }
}
public struct TrackedItem: Codable, Identifiable, Equatable, Sendable {
    public let caseId: String?
    public let linearSize: LinearSize?
    public let linearSizeOverride: LinearSize?
    public let id: String
    public let projectId: String
    public let kind: TrackedKind
    public let externalId: String
    public let title: String
    public let url: String
    public let status: String
    /// Local linearStart (moved/skipped/error) and slackStart (reacted/skipped/error, optional owner) outcomes,
    /// independent slackDone (reacted/skipped/error) and slackEyesRemoval (removed/absent/skipped/error) results,
    /// with attemptedAt and an optional safe error. Source sync preserves them. Linear sub-issues carry parentId.
    public let metadata: [String: JSONValue]
    /// Linear sub-issues: the parent's header, when pilotd resolved it.
    public let linearParent: LinearParentHeader?
    public let dismissed: Bool
    public let slack: SlackTriage?
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
                missionIds: [String]? = nil, slack: SlackTriage? = nil, linearParent: LinearParentHeader? = nil,
                linearSize: LinearSize? = nil, linearSizeOverride: LinearSize? = nil, caseId: String? = nil,
                createdAt: Double, updatedAt: Double) {
        self.caseId = caseId
        self.linearSize = linearSize; self.linearSizeOverride = linearSizeOverride
        self.id = id; self.projectId = projectId; self.kind = kind; self.externalId = externalId
        self.title = title; self.url = url; self.status = status; self.metadata = metadata; self.dismissed = dismissed
        self.sessionId = sessionId; self.missionId = missionId; self.createdAt = createdAt; self.updatedAt = updatedAt
        self.sessionIds = sessionIds ?? sessionId.map { [$0] }
        self.missionIds = missionIds ?? missionId.map { [$0] }; self.slack = slack; self.linearParent = linearParent
    }

    /// Linear sub-issues: the parent issue's ID.
    public var linearParentId: String? {
        guard kind == .linear, let id = metadata["parentId"]?.string, !id.isEmpty else { return nil }
        return id
    }

    /// A project dashboard row as a full item, so pages reuse the tracked row and its actions.
    /// Dashboard rows are never dismissed; fields the dashboard omits read as empty.
    public init(dashboard row: DashboardTrackedItem, projectId: String, kind: TrackedKind) {
        self.init(id: row.id, projectId: projectId, kind: kind, externalId: row.externalId ?? row.id,
                  title: row.title, url: row.url ?? "", status: row.status ?? "", metadata: row.metadata ?? [:],
                  sessionId: row.sessionId, missionId: row.missionId, sessionIds: row.sessionIds,
                  missionIds: row.missionIds, slack: row.slack, linearParent: row.linearParent,
                  linearSize: row.linearSize, linearSizeOverride: row.linearSizeOverride, caseId: row.caseId,
                  createdAt: row.updatedAt ?? 0, updatedAt: row.updatedAt ?? 0)
    }
}
public struct TrackedItemList: Codable, Equatable, Sendable {
    public let items: [TrackedItem]
    public let total: Int
    public init(items: [TrackedItem], total: Int) { self.items = items; self.total = total }
}
public struct TrackedItemPatch: Encodable, Sendable {
    public var linearSize: LinearSize?
    /// Confirmed Start chat/mission only. Ordinary linking remains read-only.
    public var start: Bool?
    public var slack: SlackOverrides?
    public var dismissed: Bool?
    public var sessionId: String?
    public var missionId: String?
    public var clearSession: Bool
    public var clearMission: Bool
    public init(dismissed: Bool? = nil, sessionId: String? = nil, missionId: String? = nil,
                clearSession: Bool = false, clearMission: Bool = false, slack: SlackOverrides? = nil, start: Bool? = nil,
                linearSize: LinearSize? = nil) {
        self.linearSize = linearSize
        self.start = start
        self.dismissed = dismissed; self.sessionId = sessionId; self.missionId = missionId
        self.clearSession = clearSession; self.clearMission = clearMission; self.slack = slack
    }
    enum CodingKeys: String, CodingKey { case dismissed, sessionId, missionId, slack, start, linearSize }
    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(start, forKey: .start)
        try values.encodeIfPresent(linearSize, forKey: .linearSize)
        try values.encodeIfPresent(slack, forKey: .slack)
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
/// A one-pass Slack budget override. Provider rate limits still apply.
public struct SourcePollRequest: Codable, Equatable, Sendable {
    public let force: Bool
    public init(force: Bool = false) { self.force = force }
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
    public let budgetLimited: Bool?
    public let linear: LinearSourceSummary?
    /// Slack only, in configuration order.
    public let channels: [SlackChannelStatus]?
    /// Latest browser sign-in to this kind's MCP server, shared by every project.
    public let signIn: SourceSignIn?
    public init(id: String, projectId: String, kind: TrackedKind, label: String, configured: Bool,
                status: DashboardSourceStatus, lastPolledAt: Double? = nil,
                error: String? = nil, signInCommand: String? = nil,
                nextPollAt: Double? = nil, linear: LinearSourceSummary? = nil, channels: [SlackChannelStatus]? = nil,
                signIn: SourceSignIn? = nil, budgetLimited: Bool? = nil) {
        self.id = id; self.projectId = projectId; self.kind = kind; self.label = label; self.configured = configured
        self.status = status; self.lastPolledAt = lastPolledAt; self.error = error
        self.signInCommand = signInCommand
        self.nextPollAt = nextPollAt; self.linear = linear; self.channels = channels; self.signIn = signIn
        self.budgetLimited = budgetLimited
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
