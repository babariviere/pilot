import Foundation

// Mirrors packages/protocol mission types. Keep both sides in sync.

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
    case delegated
    case done
    case dropped
    public static let fallback = MissionTaskStatus.todo

    public var label: String {
        switch self {
        case .todo: "To do"
        case .inProgress: "In progress"
        case .blocked: "Blocked"
        case .inReview: "In review"
        case .delegated: "Delegated"
        case .done: "Done"
        case .dropped: "Dropped"
        }
    }

    /// Done and dropped tasks no longer count as remaining work.
    public var isClosed: Bool { self == .done || self == .dropped }

    /// Delegation is unfinished work, but another person owns its next step.
    public var canStart: Bool { !isClosed && self != .delegated }
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

public enum MissionResourceRelationship: String, LenientStringEnum {
    case ownership
    case reference
    public static let fallback = MissionResourceRelationship.reference
}

public enum MissionEventKind: String, LenientStringEnum {
    case created, status, handoff, update, brief, decision, comment, task, claim, artifact, resource, member, coordinator, github
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
    public var phaseGating: Bool? = nil
    public var isPhaseGatingEnabled: Bool { phaseGating ?? false }
    /// The first unfinished phase with its progress, for the sidebar. Nil without one, or from an older daemon.
    public var currentPhase: MissionCurrentPhase? = nil
    /// Latest brief revision; 0 before the first save.
    public let briefRevision: Int
    /// Blocked tasks and open, unaddressed agent comments when the user coordinates.
    /// Excludes locally unread chat results. Nil when connected to an older daemon.
    public let needsYouCount: Int?
    /// Done and total tasks, dropped tasks excluded from both. Nil when connected to an older daemon.
    public let tasksDone: Int?
    public let tasksTotal: Int?
    public let needsYouReason: String?
    public let createdAt: Double
    public let updatedAt: Double
    public let completedAt: Double?
    public let archivedAt: Double?

    public var isAutopilot: Bool { autopilot ?? false }

    public init(
        id: String, projectId: String, title: String, goal: String, status: MissionStatus = .active,
        coordinatorSessionId: String? = nil, autopilot: Bool? = nil, briefRevision: Int = 0, createdAt: Double,
        updatedAt: Double, completedAt: Double? = nil, archivedAt: Double? = nil, needsYouCount: Int? = nil,
        needsYouReason: String? = nil,
        tasksDone: Int? = nil, tasksTotal: Int? = nil, phaseGating: Bool? = nil, currentPhase: MissionCurrentPhase? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.title = title
        self.goal = goal
        self.status = status
        self.coordinatorSessionId = coordinatorSessionId
        self.autopilot = autopilot
        self.phaseGating = phaseGating
        self.currentPhase = currentPhase
        self.briefRevision = briefRevision
        self.needsYouCount = needsYouCount
        self.tasksDone = tasksDone
        self.tasksTotal = tasksTotal
        self.needsYouReason = needsYouReason
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

public enum MissionDecisionAudience: String, Codable, CaseIterable, Sendable {
    case all, coordinator, reference
}

public struct MissionDecision: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let number: Int
    public let text: String
    public var audience: MissionDecisionAudience
    public let authorSessionId: String?
    public let createdAt: Double
    public let updatedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, number, text, audience, authorSessionId, createdAt, updatedAt
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        number = try values.decodeIfPresent(Int.self, forKey: .number) ?? 0
        text = try values.decode(String.self, forKey: .text)
        // Decisions from older daemons predate audiences and are reference material.
        audience = try values.decodeIfPresent(MissionDecisionAudience.self, forKey: .audience) ?? .reference
        authorSessionId = try values.decodeIfPresent(String.self, forKey: .authorSessionId)
        createdAt = try values.decode(Double.self, forKey: .createdAt)
        updatedAt = try values.decode(Double.self, forKey: .updatedAt)
    }

    /// Only user decisions are binding over the brief and editable by the user alone.
    public var isUserDecision: Bool { authorSessionId == nil }
}

public struct MissionDecisionProposal: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let decisionId: String
    public let kind: String
    public let text: String?
    public let reason: String
    public let authorSessionId: String
    public let status: String
    public let createdAt: Double
    public let resolvedAt: Double?
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

public struct MissionPhase: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let missionId: String
    public let name: String
    public let goal: String?
    public let order: Double
    public let completedAt: Double?

    public init(id: String, missionId: String, name: String, goal: String? = nil,
                order: Double = 0, completedAt: Double? = nil) {
        self.id = id
        self.missionId = missionId
        self.name = name
        self.goal = goal
        self.order = order
        self.completedAt = completedAt
    }
}

/// A mission summary's current phase: the first unfinished one in order. Dropped tasks are excluded from both counts.
public struct MissionCurrentPhase: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let done: Int
    public let total: Int

    public init(id: String, name: String, done: Int, total: Int) {
        self.id = id
        self.name = name
        self.done = done
        self.total = total
    }
}

/// POST /api/missions/:id/phases creates (name required); PATCH /api/missions/:id/phases/:phaseId sends only changes.
/// An empty goal clears it.
public struct MissionPhaseWrite: Codable, Sendable {
    public var name: String?
    public var goal: String?
    public var order: Double?

    public init(name: String? = nil, goal: String? = nil, order: Double? = nil) {
        self.name = name
        self.goal = goal
        self.order = order
    }
}

public struct MissionTask: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let number: Int
    public let title: String
    public let body: String?
    public let status: MissionTaskStatus
    public let delegatedTo: String?
    public let order: Double
    /// Legacy daemon field and name alias for the current app grouping.
    public let milestone: String?
    public var phaseId: String? = nil
    public var blockedByPhases: [String]? = nil
    public var storedStatus: MissionTaskStatus? = nil
    public let dependsOn: [String]?
    public let decisionIds: [String]?
    /// Owning chat; at most one.
    public let sessionId: String?
    /// Model for new chats on this task unless a start picks another (provider/modelId, scoped and price-capped).
    public let preferredModel: String?
    /// Thinking level for the preferred model; nil uses the model's default.
    public let preferredThinking: String?
    /// "user" or "coordinator". The coordinator never changes or overrides a user-set preference.
    public let preferredModelSetBy: String?
    public let createdAt: Double
    public let updatedAt: Double
    public let completedAt: Double?

    /// A quiet row label; manual delegation has no Linear assignee.
    public var delegationLabel: String? {
        guard status == .delegated else { return nil }
        let name = delegatedTo?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Delegated" : "Delegated to \(name)"
    }

    /// Phase gating holds the task until earlier phases finish. The daemon then reports it as blocked.
    public var isPhaseGated: Bool { !(blockedByPhases ?? []).isEmpty }

    /// The task's own status, without the blocked state phase gating derives. Views group, count and offer
    /// status changes by it, and show gating separately, like unfinished dependencies.
    public var workStatus: MissionTaskStatus { isPhaseGated ? storedStatus ?? status : status }

    public init(
        id: String, number: Int, title: String, body: String? = nil, status: MissionTaskStatus = .todo,
        order: Double = 0, milestone: String? = nil, dependsOn: [String]? = nil, decisionIds: [String]? = nil, sessionId: String? = nil,
        createdAt: Double = 0, updatedAt: Double = 0, completedAt: Double? = nil, delegatedTo: String? = nil,
        preferredModel: String? = nil, preferredThinking: String? = nil, preferredModelSetBy: String? = nil,
        phaseId: String? = nil, blockedByPhases: [String]? = nil, storedStatus: MissionTaskStatus? = nil
    ) {
        self.id = id
        self.number = number
        self.title = title
        self.body = body
        self.status = status
        self.delegatedTo = delegatedTo
        self.order = order
        self.milestone = milestone
        self.phaseId = phaseId
        self.blockedByPhases = blockedByPhases
        self.storedStatus = storedStatus
        self.dependsOn = dependsOn
        self.decisionIds = decisionIds
        self.sessionId = sessionId
        self.preferredModel = preferredModel
        self.preferredThinking = preferredThinking
        self.preferredModelSetBy = preferredModelSetBy
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
/// `preferredModel` replaces the preference, including its thinking level; `.clear` removes it.
public struct MissionTaskWrite: Encodable, Sendable {
    public var title: String?
    public var body: String?
    public var status: MissionTaskStatus?
    public var order: Double?
    public var milestone: String?
    public var phaseId: NullableUpdate<String>? = nil
    public var overridePhaseGating: Bool? = nil
    public var dependsOn: [String]?
    public var decisionIds: [String]?
    public var sessionId: NullableUpdate<String>?
    public var preferredModel: NullableUpdate<String>?
    public var preferredThinking: NullableUpdate<String>?

    public init(
        title: String? = nil, body: String? = nil, status: MissionTaskStatus? = nil, order: Double? = nil,
        milestone: String? = nil, dependsOn: [String]? = nil, decisionIds: [String]? = nil, sessionId: NullableUpdate<String>? = nil,
        preferredModel: NullableUpdate<String>? = nil, preferredThinking: NullableUpdate<String>? = nil,
        phaseId: NullableUpdate<String>? = nil, overridePhaseGating: Bool? = nil
    ) {
        self.title = title
        self.body = body
        self.status = status
        self.order = order
        self.milestone = milestone
        self.dependsOn = dependsOn
        self.decisionIds = decisionIds
        self.sessionId = sessionId
        self.preferredModel = preferredModel
        self.preferredThinking = preferredThinking
        self.phaseId = phaseId
        self.overridePhaseGating = overridePhaseGating
    }

    private enum CodingKeys: String, CodingKey {
        case title, body, status, order, milestone, dependsOn, decisionIds, sessionId
        case preferredModel, preferredThinking, phaseId, overridePhaseGating
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(body, forKey: .body)
        try container.encodeIfPresent(status, forKey: .status)
        try container.encodeIfPresent(order, forKey: .order)
        try container.encodeIfPresent(milestone, forKey: .milestone)
        try container.encodeUpdate(phaseId, forKey: .phaseId)
        try container.encodeIfPresent(overridePhaseGating, forKey: .overridePhaseGating)
        try container.encodeIfPresent(dependsOn, forKey: .dependsOn)
        try container.encodeIfPresent(decisionIds, forKey: .decisionIds)
        try container.encodeUpdate(sessionId, forKey: .sessionId)
        try container.encodeUpdate(preferredModel, forKey: .preferredModel)
        try container.encodeUpdate(preferredThinking, forKey: .preferredThinking)
    }
}

public struct MissionArtifactLink: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let taskId: String?
    public let artifactId: String
    public let sessionId: String
    public let title: String
    /// Artifact kind. Kept as a string so newer kinds still decode.
    public let kind: String
    /// Pinned revision; nil opens the latest.
    public let revision: Int?
    public let linkedBySessionId: String?
    public let linkedAt: Double

    public var id: String { "\(artifactId)/\(taskId ?? "mission")" }
}

/// The chat that owns a resource's pull request.
public struct MissionResourceOwner: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// Result of binding or unbinding a chat's pull request.
public struct PullRequestBindingResult: Codable, Equatable, Sendable {
    public let changed: Bool
    public let previousOwner: MissionResourceOwner?
    public let taskLinkRemoved: Bool

    public init(changed: Bool, previousOwner: MissionResourceOwner? = nil, taskLinkRemoved: Bool) {
        self.changed = changed
        self.previousOwner = previousOwner
        self.taskLinkRemoved = taskLinkRemoved
    }
}

/// Linear lifecycle authority, independent of GitHub PR ownership.
public enum MissionLinearRole: String, LenientStringEnum {
    case reference, managed, contribution
    public static let fallback = MissionLinearRole.reference
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
    /// Nil for older daemons: task GitHub PRs imply ownership; other links are references.
    public var relationship: MissionResourceRelationship? = nil
    public var owner: MissionResourceOwner? = nil
    /// Nil from older daemons means read-only reference.
    public var linearRole: MissionLinearRole? = nil
    public var linearKey: String? = nil

    public var displayTitle: String { title ?? externalId ?? url }

    public var badgeTitle: String {
        if let pullRequest { return pullRequest.taskLinkLabel }
        if kind == .githubPullRequest, let number = externalId?.split(separator: "#").last { return "PR #\(number)" }
        return externalId ?? displayTitle
    }
}

public struct MissionResourceWrite: Codable, Sendable {
    public let url: String
    public let title: String?
    public let taskId: String?
    public let relationship: MissionResourceRelationship?
    public let linearRole: MissionLinearRole?

    public init(url: String, title: String? = nil, taskId: String? = nil,
                relationship: MissionResourceRelationship? = nil, linearRole: MissionLinearRole? = nil) {
        self.url = url
        self.title = title
        self.taskId = taskId
        self.relationship = relationship
        self.linearRole = linearRole
    }
}

/// PATCH /api/missions/:id/resources/:resourceId. Existing references require explicit upgrade.
public struct MissionResourceUpdate: Codable, Sendable {
    public let linearRole: MissionLinearRole

    public init(linearRole: MissionLinearRole) { self.linearRole = linearRole }
}

/// POST /api/missions/:id/decisions; PATCH /api/missions/:id/decisions/:decisionId.
public struct MissionDecisionWrite: Codable, Sendable {
    public let text: String?
    public let audience: MissionDecisionAudience?

    public init(text: String? = nil, audience: MissionDecisionAudience? = nil) {
        self.text = text
        self.audience = audience
    }
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
    public let taskId: String?
    public let sessionId: String
    public let artifactId: String
    public let revision: Int?

    public init(sessionId: String, artifactId: String, revision: Int? = nil, taskId: String? = nil) {
        self.taskId = taskId
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
    public let decisionProposals: [MissionDecisionProposal]?
    public let comments: [MissionComment]
    public let tasks: [MissionTask]
    /// Nil with older daemons. The legacy milestone name remains readable on tasks.
    public var phases: [MissionPhase]? = nil
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
    public var startCoordinator: Bool?
    public var model: String?
    public var thinking: String?
    public var message: String?

    public init(
        projectId: String, title: String, goal: String, brief: String? = nil, tasks: [MissionTaskDraft]? = nil,
        fromSessionId: String? = nil, coordinator: Bool? = nil, draft: Bool? = nil,
        startCoordinator: Bool? = nil, model: String? = nil, thinking: String? = nil, message: String? = nil
    ) {
        self.projectId = projectId
        self.title = title
        self.goal = goal
        self.brief = brief
        self.tasks = tasks
        self.fromSessionId = fromSessionId
        self.coordinator = coordinator
        self.draft = draft
        self.startCoordinator = startCoordinator
        self.model = model
        self.thinking = thinking
        self.message = message
    }
}

/// POST /api/missions/:id/coordinator/start.
public struct StartMissionCoordinatorRequest: Codable, Sendable {
    public var model: String?
    public var thinking: String?
    public var message: String?

    public init(model: String? = nil, thinking: String? = nil, message: String? = nil) {
        self.model = model
        self.thinking = thinking
        self.message = message
    }
}

/// PATCH /api/missions/:id. `coordinatorSessionId: .clear` hands coordination back to the user.
public struct UpdateMissionRequest: Encodable, Sendable {
    public var title: String?
    public var goal: String?
    public var status: MissionStatus?
    public var coordinatorSessionId: NullableUpdate<String>?
    public var autopilot: Bool?
    public var phaseGating: Bool? = nil

    public init(
        title: String? = nil, goal: String? = nil, status: MissionStatus? = nil,
        coordinatorSessionId: NullableUpdate<String>? = nil, autopilot: Bool? = nil, phaseGating: Bool? = nil
    ) {
        self.title = title
        self.goal = goal
        self.status = status
        self.coordinatorSessionId = coordinatorSessionId
        self.autopilot = autopilot
        self.phaseGating = phaseGating
    }

    private enum CodingKeys: String, CodingKey { case title, goal, status, coordinatorSessionId, autopilot, phaseGating }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(goal, forKey: .goal)
        try container.encodeIfPresent(status, forKey: .status)
        try container.encodeUpdate(coordinatorSessionId, forKey: .coordinatorSessionId)
        try container.encodeIfPresent(autopilot, forKey: .autopilot)
        try container.encodeIfPresent(phaseGating, forKey: .phaseGating)
    }
}

/// A read reference to an existing artifact. Omitted revision follows the latest.
public struct MissionArtifactReference: Codable, Sendable {
    public let artifactId: String
    public let revision: Int?

    public init(artifactId: String, revision: Int? = nil) {
        self.artifactId = artifactId
        self.revision = revision
    }
}

public struct MissionLinkReference: Codable, Sendable {
    public let url: String
    public let title: String?

    public init(url: String, title: String? = nil) {
        self.url = url
        self.title = title
    }
}

/// POST /api/missions/:id/tasks/:taskId/start: a new chat in the mission's project that claims the task.
public struct StartMissionTaskRequest: Codable, Sendable {
    public var artifacts: [MissionArtifactReference]?
    public var links: [MissionLinkReference]?
    public var message: String?
    public var model: String?
    public var thinking: String?
    public var mode: ChatMode?
    public var baseBranch: String?
    /// The user starts a task that phase gating holds anyway.
    public var overridePhaseGating: Bool? = nil

    public init(message: String? = nil, model: String? = nil, thinking: String? = nil, mode: ChatMode? = nil,
                baseBranch: String? = nil, artifacts: [MissionArtifactReference]? = nil,
                links: [MissionLinkReference]? = nil, overridePhaseGating: Bool? = nil) {
        self.artifacts = artifacts
        self.links = links
        self.message = message
        self.model = model
        self.thinking = thinking
        self.mode = mode
        self.baseBranch = baseBranch
        self.overridePhaseGating = overridePhaseGating
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
