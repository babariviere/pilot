import Foundation

// Mirrors packages/protocol missions (PLAN.md §5.7). Keep both sides in sync.

/// String enums that decode values from newer daemons as a fallback instead of failing the whole payload.
public protocol LenientStringEnum: RawRepresentable, Codable, Hashable, Sendable where RawValue == String {
    static var fallback: Self { get }
}

public extension LenientStringEnum {
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .fallback
    }
}

public enum MissionStatus: String, LenientStringEnum {
    case active
    case done
    case archived
    public static let fallback = MissionStatus.active
}

public enum MissionTaskStatus: String, LenientStringEnum, CaseIterable {
    case todo
    case inProgress = "in_progress"
    case blocked
    case inReview = "in_review"
    case done
    case dropped
    public static let fallback = MissionTaskStatus.todo

    public var label: String {
        switch self {
        case .todo: "To do"
        case .inProgress: "In progress"
        case .blocked: "Blocked"
        case .inReview: "In review"
        case .done: "Done"
        case .dropped: "Dropped"
        }
    }

    /// Done and dropped tasks no longer count as remaining work.
    public var isClosed: Bool { self == .done || self == .dropped }
}

public enum MissionHealth: String, LenientStringEnum {
    case onTrack = "on_track"
    case atRisk = "at_risk"
    case offTrack = "off_track"
    public static let fallback = MissionHealth.onTrack
}

public enum MissionResourceKind: String, LenientStringEnum {
    case linearProject = "linear.project"
    case linearIssue = "linear.issue"
    case githubIssue = "github.issue"
    case githubPullRequest = "github.pr"
    case slackThread = "slack.thread"
    case url
    public static let fallback = MissionResourceKind.url
}

public enum MissionEventKind: String, LenientStringEnum {
    case created, status, handoff, update, brief, decision, comment, task, claim, artifact, resource, member, coordinator
    public static let fallback = MissionEventKind.update
}

public struct Mission: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let goal: String
    public let status: MissionStatus
    /// Nil: the user coordinates.
    public let coordinatorSessionId: String?
    public let autopilot: Bool?
    /// Latest brief revision; 0 before the first save.
    public let briefRevision: Int
    public let createdAt: Double
    public let updatedAt: Double
    public let completedAt: Double?
    public let archivedAt: Double?

    public var isAutopilot: Bool { autopilot ?? false }

    public init(
        id: String, projectId: String, title: String, goal: String, status: MissionStatus = .active,
        coordinatorSessionId: String? = nil, autopilot: Bool? = nil, briefRevision: Int = 0, createdAt: Double,
        updatedAt: Double, completedAt: Double? = nil, archivedAt: Double? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.title = title
        self.goal = goal
        self.status = status
        self.coordinatorSessionId = coordinatorSessionId
        self.autopilot = autopilot
        self.briefRevision = briefRevision
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.archivedAt = archivedAt
    }
}

/// One immutable brief revision. A nil author means the user wrote it.
public struct MissionBrief: Codable, Equatable, Hashable, Sendable {
    public let missionId: String
    public let revision: Int
    public let markdown: String
    public let authorSessionId: String?
    public let createdAt: Double
}

public struct MissionBriefRevision: Codable, Equatable, Hashable, Sendable {
    public let revision: Int
    public let authorSessionId: String?
    public let createdAt: Double
}

/// PUT /api/missions/:id/brief. A stale expectedRevision is rejected with 409.
public struct MissionBriefWrite: Codable, Sendable {
    public let markdown: String
    public let expectedRevision: Int

    public init(markdown: String, expectedRevision: Int) {
        self.markdown = markdown
        self.expectedRevision = expectedRevision
    }
}

public struct MissionDecision: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let text: String
    public let authorSessionId: String?
    public let createdAt: Double
    public let updatedAt: Double

    /// Only user decisions are binding over the brief and editable by the user alone.
    public var isUserDecision: Bool { authorSessionId == nil }
}

public struct MissionComment: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let text: String
    public let anchor: String?
    public let revision: Int?
    public let authorSessionId: String?
    public let targetSessionId: String?
    public let createdAt: Double
    public let resolvedAt: Double?
    public let resolvedBySessionId: String?

    public var isOpen: Bool { resolvedAt == nil }
}

public struct MissionTask: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let number: Int
    public let title: String
    public let body: String?
    public let status: MissionTaskStatus
    public let order: Double
    public let milestone: String?
    public let dependsOn: [String]?
    /// Owning chat; at most one.
    public let sessionId: String?
    public let createdAt: Double
    public let updatedAt: Double
    public let completedAt: Double?

    public init(
        id: String, number: Int, title: String, body: String? = nil, status: MissionTaskStatus = .todo,
        order: Double = 0, milestone: String? = nil, dependsOn: [String]? = nil, sessionId: String? = nil,
        createdAt: Double = 0, updatedAt: Double = 0, completedAt: Double? = nil
    ) {
        self.id = id
        self.number = number
        self.title = title
        self.body = body
        self.status = status
        self.order = order
        self.milestone = milestone
        self.dependsOn = dependsOn
        self.sessionId = sessionId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
    }
}

/// A PATCH field that can be set or explicitly cleared. Clearing encodes JSON null instead of omitting the key.
public enum NullableUpdate<Value: Encodable & Sendable>: Sendable {
    case set(Value)
    case clear
}

extension KeyedEncodingContainer {
    mutating func encodeUpdate<Value>(_ update: NullableUpdate<Value>?, forKey key: Key) throws {
        switch update {
        case let .set(value)?: try encode(value, forKey: key)
        case .clear?: try encodeNil(forKey: key)
        case nil: break
        }
    }
}

/// POST creates; PATCH sends only changed fields. `sessionId` assigns a member chat, or `.clear` releases.
public struct MissionTaskWrite: Encodable, Sendable {
    public var title: String?
    public var body: String?
    public var status: MissionTaskStatus?
    public var order: Double?
    public var milestone: String?
    public var dependsOn: [String]?
    public var sessionId: NullableUpdate<String>?

    public init(
        title: String? = nil, body: String? = nil, status: MissionTaskStatus? = nil, order: Double? = nil,
        milestone: String? = nil, dependsOn: [String]? = nil, sessionId: NullableUpdate<String>? = nil
    ) {
        self.title = title
        self.body = body
        self.status = status
        self.order = order
        self.milestone = milestone
        self.dependsOn = dependsOn
        self.sessionId = sessionId
    }

    private enum CodingKeys: String, CodingKey { case title, body, status, order, milestone, dependsOn, sessionId }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(body, forKey: .body)
        try container.encodeIfPresent(status, forKey: .status)
        try container.encodeIfPresent(order, forKey: .order)
        try container.encodeIfPresent(milestone, forKey: .milestone)
        try container.encodeIfPresent(dependsOn, forKey: .dependsOn)
        try container.encodeUpdate(sessionId, forKey: .sessionId)
    }
}

public struct MissionArtifactLink: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let artifactId: String
    public let sessionId: String
    public let title: String
    /// Artifact kind. Kept as a string so newer kinds still decode.
    public let kind: String
    /// Pinned revision; nil opens the latest.
    public let revision: Int?
    public let linkedBySessionId: String?
    public let linkedAt: Double

    public var id: String { artifactId }
}

public struct MissionResource: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let taskId: String?
    public let pullRequest: SessionPullRequest?
    public let url: String
    public let title: String?
    public let kind: MissionResourceKind
    public let externalId: String?
    public let addedBySessionId: String?
    public let createdAt: Double

    public var displayTitle: String { title ?? externalId ?? url }

    public var badgeTitle: String {
        if let pullRequest { return pullRequest.label }
        if kind == .githubPullRequest, let number = externalId?.split(separator: "#").last { return "PR #\(number)" }
        return externalId ?? displayTitle
    }
}

public struct MissionResourceWrite: Codable, Sendable {
    public let url: String
    public let title: String?
    public let taskId: String?

    public init(url: String, title: String? = nil, taskId: String? = nil) {
        self.url = url
        self.title = title
        self.taskId = taskId
    }
}

/// POST /api/missions/:id/decisions; PATCH /api/missions/:id/decisions/:decisionId.
public struct MissionDecisionWrite: Codable, Sendable {
    public let text: String

    public init(text: String) { self.text = text }
}

/// POST /api/missions/:id/comments.
public struct MissionCommentWrite: Codable, Sendable {
    public let text: String
    public let anchor: String?
    public let targetSessionId: String?

    public init(text: String, anchor: String? = nil, targetSessionId: String? = nil) {
        self.text = text
        self.anchor = anchor
        self.targetSessionId = targetSessionId
    }
}

/// POST /api/missions/:id/artifacts. The artifact must belong to a member chat.
public struct MissionArtifactLinkWrite: Codable, Sendable {
    public let sessionId: String
    public let artifactId: String
    public let revision: Int?

    public init(sessionId: String, artifactId: String, revision: Int? = nil) {
        self.sessionId = sessionId
        self.artifactId = artifactId
        self.revision = revision
    }
}

public enum MissionEventWriteKind: String, Codable, Sendable {
    case update
    case handoff
}

/// POST /api/missions/:id/events: a handoff or status update.
public struct MissionEventWrite: Codable, Sendable {
    public let text: String
    public let kind: MissionEventWriteKind?
    public let health: MissionHealth?

    public init(text: String, kind: MissionEventWriteKind? = nil, health: MissionHealth? = nil) {
        self.text = text
        self.kind = kind
        self.health = health
    }
}

public struct MissionEvent: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: Int
    public let kind: MissionEventKind
    public let text: String
    public let sessionId: String?
    public let taskId: String?
    public let health: MissionHealth?
    public let at: Double
}

/// GET /api/missions/:id and WS `mission`. Member sessions come from the session list (`missionId`).
public struct MissionDetail: Codable, Equatable, Sendable {
    public let mission: Mission
    public let brief: MissionBrief?
    public let decisions: [MissionDecision]
    public let comments: [MissionComment]
    public let tasks: [MissionTask]
    public let artifacts: [MissionArtifactLink]
    public let resources: [MissionResource]
    public let events: [MissionEvent]

    /// Done and total tasks, for the progress bar. Dropped tasks are excluded from both.
    public var progress: (done: Int, total: Int) {
        let counted = tasks.filter { $0.status != .dropped }
        return (counted.filter { $0.status == .done }.count, counted.count)
    }

    /// Tasks in display order.
    public var orderedTasks: [MissionTask] {
        tasks.sorted { ($0.order, $0.number) < ($1.order, $1.number) }
    }
}

public struct MissionTaskDraft: Codable, Equatable, Sendable {
    public var title: String
    public var body: String?

    public init(title: String, body: String? = nil) {
        self.title = title
        self.body = body
    }
}

/// POST /api/missions.
public struct CreateMissionRequest: Codable, Sendable {
    public var projectId: String
    public var title: String
    public var goal: String
    public var brief: String?
    public var tasks: [MissionTaskDraft]?
    /// "Make a mission": this chat joins, as coordinator unless `coordinator` is false.
    public var fromSessionId: String?
    public var coordinator: Bool?
    /// With fromSessionId: ask that chat to draft the goal, brief and tasks. The daemon defaults to true.
    public var draft: Bool?

    public init(
        projectId: String, title: String, goal: String, brief: String? = nil, tasks: [MissionTaskDraft]? = nil,
        fromSessionId: String? = nil, coordinator: Bool? = nil, draft: Bool? = nil
    ) {
        self.projectId = projectId
        self.title = title
        self.goal = goal
        self.brief = brief
        self.tasks = tasks
        self.fromSessionId = fromSessionId
        self.coordinator = coordinator
        self.draft = draft
    }
}

/// PATCH /api/missions/:id. `coordinatorSessionId: .clear` hands coordination back to the user.
public struct UpdateMissionRequest: Encodable, Sendable {
    public var title: String?
    public var goal: String?
    public var status: MissionStatus?
    public var coordinatorSessionId: NullableUpdate<String>?
    public var autopilot: Bool?

    public init(
        title: String? = nil, goal: String? = nil, status: MissionStatus? = nil,
        coordinatorSessionId: NullableUpdate<String>? = nil, autopilot: Bool? = nil
    ) {
        self.title = title
        self.goal = goal
        self.status = status
        self.coordinatorSessionId = coordinatorSessionId
        self.autopilot = autopilot
    }

    private enum CodingKeys: String, CodingKey { case title, goal, status, coordinatorSessionId, autopilot }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(goal, forKey: .goal)
        try container.encodeIfPresent(status, forKey: .status)
        try container.encodeUpdate(coordinatorSessionId, forKey: .coordinatorSessionId)
        try container.encodeIfPresent(autopilot, forKey: .autopilot)
    }
}

/// POST /api/missions/:id/tasks/:taskId/start: a new chat in the mission's project that claims the task.
public struct StartMissionTaskRequest: Codable, Sendable {
    public var message: String?
    public var model: String?
    public var thinking: String?
    public var mode: ChatMode?
    public var baseBranch: String?

    public init(message: String? = nil, model: String? = nil, thinking: String? = nil, mode: ChatMode? = nil,
                baseBranch: String? = nil) {
        self.message = message
        self.model = model
        self.thinking = thinking
        self.mode = mode
        self.baseBranch = baseBranch
    }
}

/// PUT /api/sessions/:id/mission. The session must belong to the mission's project.
public struct JoinMissionRequest: Codable, Sendable {
    public let missionId: String
    public let taskId: String?

    public init(missionId: String, taskId: String? = nil) {
        self.missionId = missionId
        self.taskId = taskId
    }
}
