import Foundation

// Mirrors packages/protocol project dashboard (GET /api/projects/:id/dashboard, WS `dashboard`,
// `dashboard.counts`). Keep both sides in sync.

/// A bounded slice of a section: at most `ProjectDashboard.sectionLimit` rows plus the full count.
public struct DashboardSection<Item: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    /// Every matching row, not just those in `items`.
    public let total: Int
    public let items: [Item]

    public init(total: Int, items: [Item]) {
        self.total = total
        self.items = items
    }

    /// Rows the section does not show, for a "N more" link.
    public var hiddenCount: Int { max(0, total - items.count) }
}

/// Most urgent first. Unknown values from newer daemons read as `unread`.
public enum DashboardNeedsYouKind: String, LenientStringEnum {
    case failed
    case question
    case scheduledFailed = "scheduled_failed"
    case unread
    case longJob = "long_job"
    case toolStall = "tool_stall"
    case prStuck = "pr_stuck"
    case noPR = "no_pr"
    case mcp
    public static let fallback = DashboardNeedsYouKind.unread
}

public struct DashboardNeedsYouItem: Codable, Identifiable, Equatable, Sendable {
    public let kind: DashboardNeedsYouKind
    /// Stable row key.
    public let id: String
    public let title: String
    public let sessionId: String?
    public let missionId: String?
    public let scheduledId: String?
    public let outcome: SessionOutcome?
    /// Failure or stop reason, one short line.
    public let reason: String?
    /// Nil for older daemons; presentation derives the same vocabulary from legacy fields.
    public let attentionReason: NeedsYouReason?
    /// `question`: blocked tasks plus open comments awaiting the user.
    public let count: Int?
    /// Epoch milliseconds.
    public let at: Double

    public init(
        kind: DashboardNeedsYouKind, id: String, title: String, sessionId: String? = nil, missionId: String? = nil,
        scheduledId: String? = nil, outcome: SessionOutcome? = nil, reason: String? = nil, count: Int? = nil,
        at: Double, attentionReason: NeedsYouReason? = nil
    ) {
        self.kind = kind
        self.id = id
        self.title = title
        self.sessionId = sessionId
        self.missionId = missionId
        self.scheduledId = scheduledId
        self.outcome = outcome
        self.reason = reason
        self.attentionReason = attentionReason
        self.count = count
        self.at = at
    }
}

public struct DashboardPullRequestRef: Codable, Equatable, Hashable, Sendable {
    public let number: Int
    public let url: String
    public let state: PullRequestState

    public init(number: Int, url: String, state: PullRequestState) {
        self.number = number
        self.url = url
        self.state = state
    }
}

public enum DashboardWorkState: String, LenientStringEnum {
    case starting
    case working
    public static let fallback = DashboardWorkState.working
}

public struct DashboardWorkingItem: Codable, Identifiable, Equatable, Sendable {
    public let sessionId: String
    public let title: String
    public let state: DashboardWorkState
    public let mode: ChatMode
    public let missionId: String?
    public let missionTitle: String?
    public let model: String?
    public let branch: String?
    public let pullRequest: DashboardPullRequestRef?
    /// Latest user submission (else creation), epoch milliseconds. Elapsed time is computed locally.
    public let startedAt: Double

    public var id: String { sessionId }

    public init(
        sessionId: String, title: String, state: DashboardWorkState = .working, mode: ChatMode = .build,
        missionId: String? = nil, missionTitle: String? = nil, model: String? = nil, branch: String? = nil,
        pullRequest: DashboardPullRequestRef? = nil, startedAt: Double
    ) {
        self.sessionId = sessionId
        self.title = title
        self.state = state
        self.mode = mode
        self.missionId = missionId
        self.missionTitle = missionTitle
        self.model = model
        self.branch = branch
        self.pullRequest = pullRequest
        self.startedAt = startedAt
    }
}

public enum DashboardReadinessState: String, LenientStringEnum {
    case ready
    case pending
    case blocked
    public static let fallback = DashboardReadinessState.pending
}

/// Provisional merge readiness. Absent until the daemon tracks it.
public struct DashboardPullRequestReadiness: Codable, Equatable, Sendable {
    public let state: DashboardReadinessState
    /// Short blocker labels, such as "failing checks: build".
    public let reasons: [String]?

    public init(state: DashboardReadinessState, reasons: [String]? = nil) {
        self.state = state
        self.reasons = reasons
    }
}

public enum DashboardPullRequestState: String, LenientStringEnum {
    case draft
    case open
    public static let fallback = DashboardPullRequestState.open
}

public struct DashboardPullRequest: Codable, Identifiable, Equatable, Sendable {
    public let number: Int
    public let url: String
    public let title: String
    public let state: DashboardPullRequestState
    public let branch: String?
    /// Chat that owns the PR.
    public let sessionId: String
    public let sessionTitle: String
    public let missionId: String?
    public let checkedAt: Double
    public let readiness: DashboardPullRequestReadiness?

    public var id: String { url }
    public var isReady: Bool { state == .open && readiness?.state == .ready }

    public init(
        number: Int, url: String, title: String, state: DashboardPullRequestState = .open, branch: String? = nil,
        sessionId: String, sessionTitle: String, missionId: String? = nil, checkedAt: Double,
        readiness: DashboardPullRequestReadiness? = nil
    ) {
        self.number = number
        self.url = url
        self.title = title
        self.state = state
        self.branch = branch
        self.sessionId = sessionId
        self.sessionTitle = sessionTitle
        self.missionId = missionId
        self.checkedAt = checkedAt
        self.readiness = readiness
    }
}

public struct DashboardMission: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    /// Tasks by status, and tasks overall (dropped tasks excluded). To do and delegated tasks are the rest
    /// (`tasksToDo`). Older daemons send only done and total: the other counts are then zero.
    public let tasksDone: Int
    public let tasksInReview: Int
    public let tasksInProgress: Int
    public let tasksBlocked: Int
    public let tasksTotal: Int
    /// Member chats working now.
    public let working: Int
    public let needsYou: Int
    public let coordinatorSessionId: String?

    public init(
        id: String, title: String, tasksDone: Int = 0, tasksInReview: Int = 0, tasksInProgress: Int = 0,
        tasksBlocked: Int = 0, tasksTotal: Int = 0, working: Int = 0, needsYou: Int = 0,
        coordinatorSessionId: String? = nil
    ) {
        self.id = id
        self.title = title
        self.tasksDone = tasksDone
        self.tasksInReview = tasksInReview
        self.tasksInProgress = tasksInProgress
        self.tasksBlocked = tasksBlocked
        self.tasksTotal = tasksTotal
        self.working = working
        self.needsYou = needsYou
        self.coordinatorSessionId = coordinatorSessionId
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        tasksDone = try container.decode(Int.self, forKey: .tasksDone)
        tasksInReview = try container.decodeIfPresent(Int.self, forKey: .tasksInReview) ?? 0
        tasksInProgress = try container.decodeIfPresent(Int.self, forKey: .tasksInProgress) ?? 0
        tasksBlocked = try container.decodeIfPresent(Int.self, forKey: .tasksBlocked) ?? 0
        tasksTotal = try container.decode(Int.self, forKey: .tasksTotal)
        working = try container.decode(Int.self, forKey: .working)
        needsYou = try container.decode(Int.self, forKey: .needsYou)
        coordinatorSessionId = try container.decodeIfPresent(String.self, forKey: .coordinatorSessionId)
    }

    /// Tasks neither done, in review, in progress nor blocked: to do and delegated. Never negative.
    public var tasksToDo: Int {
        max(0, tasksTotal - max(0, tasksDone) - max(0, tasksInReview) - max(0, tasksInProgress) - max(0, tasksBlocked))
    }
}

public struct DashboardRecentItem: Codable, Identifiable, Equatable, Sendable {
    public let sessionId: String
    public let title: String
    public let outcome: SessionOutcome
    /// Epoch milliseconds.
    public let outcomeAt: Double
    public let missionId: String?
    public let branch: String?
    public let pullRequest: DashboardPullRequestRef?

    public var id: String { sessionId }

    public init(
        sessionId: String, title: String, outcome: SessionOutcome, outcomeAt: Double, missionId: String? = nil,
        branch: String? = nil, pullRequest: DashboardPullRequestRef? = nil
    ) {
        self.sessionId = sessionId
        self.title = title
        self.outcome = outcome
        self.outcomeAt = outcomeAt
        self.missionId = missionId
        self.branch = branch
        self.pullRequest = pullRequest
    }
}

public enum DashboardScheduledKind: String, LenientStringEnum {
    case chat
    case message
    public static let fallback = DashboardScheduledKind.chat
}

public enum DashboardScheduledTrigger: String, LenientStringEnum {
    case onWake = "on_wake"
    case onBack = "on_back"
    case onOnline = "on_online"
    case removed
    case at
    public static let fallback = DashboardScheduledTrigger.onBack

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        if value == "on_join_network" || value == "on_leave_network" { self = .removed }
        else { self = Self(rawValue: value) ?? Self.fallback }
    }
}

public enum DashboardScheduledState: String, LenientStringEnum {
    case cancelled
    case pending
    case failed
    public static let fallback = DashboardScheduledState.pending
}

/// Extension point for scheduled items. Empty until the scheduler exists.
public struct DashboardScheduledItem: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let kind: DashboardScheduledKind
    public let trigger: DashboardScheduledTrigger
    /// Epoch milliseconds, for `at` triggers.
    public let at: Double?
    public let state: DashboardScheduledState
    public let error: String?
    public let sessionId: String?

    public init(
        id: String, title: String, kind: DashboardScheduledKind = .chat,
        trigger: DashboardScheduledTrigger = .onBack, at: Double? = nil, state: DashboardScheduledState = .pending,
        error: String? = nil, sessionId: String? = nil
    ) {
        self.id = id
        self.title = title
        self.kind = kind
        self.trigger = trigger
        self.at = at
        self.state = trigger == .removed ? .cancelled : state
        self.error = trigger == .removed ? "Wi-Fi triggers were removed" : error
        self.sessionId = sessionId
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, kind, trigger, at, state, error, sessionId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            title: try c.decode(String.self, forKey: .title),
            kind: try c.decode(DashboardScheduledKind.self, forKey: .kind),
            trigger: try c.decode(DashboardScheduledTrigger.self, forKey: .trigger),
            at: try c.decodeIfPresent(Double.self, forKey: .at),
            state: try c.decode(DashboardScheduledState.self, forKey: .state),
            error: try c.decodeIfPresent(String.self, forKey: .error),
            sessionId: try c.decodeIfPresent(String.self, forKey: .sessionId)
        )
    }
}

public enum DashboardSourceStatus: String, LenientStringEnum {
    case notConfigured = "not_configured"
    case idle
    case ok
    case syncing
    case signInRequired = "sign_in_required"
    case error
    public static let fallback = DashboardSourceStatus.error
}

public struct DashboardTrackedItem: Codable, Identifiable, Equatable, Sendable {
    public let caseId: String?
    public let linearSize: LinearSize?
    public let linearSizeOverride: LinearSize?
    public let slack: SlackTriage?
    public let id: String
    public let title: String
    public let url: String?
    /// Source-specific label, for example a Linear state.
    public let status: String?
    public let updatedAt: Double?
    public let externalId: String?
    public let metadata: [String: JSONValue]?
    /// Linear sub-issues: the parent's header.
    public let linearParent: LinearParentHeader?
    public let sessionId: String?
    public let missionId: String?
    public let sessionIds: [String]?
    public let missionIds: [String]?

    public init(id: String, title: String, url: String? = nil, status: String? = nil, updatedAt: Double? = nil,
                externalId: String? = nil, metadata: [String: JSONValue]? = nil,
                sessionId: String? = nil, missionId: String? = nil, sessionIds: [String]? = nil,
                missionIds: [String]? = nil, slack: SlackTriage? = nil, linearParent: LinearParentHeader? = nil,
                linearSize: LinearSize? = nil, linearSizeOverride: LinearSize? = nil, caseId: String? = nil) {
        self.caseId = caseId
        self.linearSize = linearSize; self.linearSizeOverride = linearSizeOverride
        self.slack = slack
        self.linearParent = linearParent
        self.id = id
        self.title = title
        self.url = url
        self.status = status
        self.updatedAt = updatedAt
        self.externalId = externalId; self.metadata = metadata
        self.sessionId = sessionId; self.missionId = missionId
        self.sessionIds = sessionIds; self.missionIds = missionIds
    }
}

/// Extension point for tracked items: one group per configured source, with its own status.
public struct DashboardTrackedSource: Codable, Identifiable, Equatable, Sendable {
    public let commonCases: [SlackCommonCase]?
    /// Source identifier, for example "linear" or "slack".
    public let source: String
    public let label: String
    public let status: DashboardSourceStatus
    public let error: String?
    /// Every active item, including those in `done`.
    public let total: Int
    /// Latest first. Linear lists open issues only: in progress, then to do, each by priority.
    public let items: [DashboardTrackedItem]
    /// Linear only: completed and canceled issues, latest first, shown collapsed.
    public let done: DashboardSection<DashboardTrackedItem>?
    public let linear: LinearSourceSummary?

    public var id: String { source }

    public init(
        source: String, label: String, status: DashboardSourceStatus = .ok, error: String? = nil, total: Int = 0,
        items: [DashboardTrackedItem] = [], done: DashboardSection<DashboardTrackedItem>? = nil,
        linear: LinearSourceSummary? = nil, commonCases: [SlackCommonCase]? = nil
    ) {
        self.commonCases = commonCases
        self.source = source
        self.label = label
        self.status = status
        self.error = error
        self.total = total
        self.items = items
        self.done = done
        self.linear = linear
    }
}

public struct ProjectDashboardSummary: Codable, Equatable, Sendable {
    /// Active (not archived) chats. Zero means a new project.
    public let chats: Int
    public let working: Int
    public let needsYou: Int
    public let openPullRequests: Int
    public let readyPullRequests: Int
    public let activeMissions: Int

    public init(
        chats: Int = 0, working: Int = 0, needsYou: Int = 0, openPullRequests: Int = 0, readyPullRequests: Int = 0,
        activeMissions: Int = 0
    ) {
        self.chats = chats
        self.working = working
        self.needsYou = needsYou
        self.openPullRequests = openPullRequests
        self.readyPullRequests = readyPullRequests
        self.activeMissions = activeMissions
    }
}

public struct ProjectDashboard: Codable, Equatable, Sendable {
    /// Rows per section, matching the daemon's DASHBOARD_SECTION_LIMIT.
    public static let sectionLimit = 5

    public let projectId: String
    public let summary: ProjectDashboardSummary
    public let needsYou: DashboardSection<DashboardNeedsYouItem>
    public let working: DashboardSection<DashboardWorkingItem>
    /// Open and draft PRs, Ready to merge first.
    public let pullRequests: DashboardSection<DashboardPullRequest>
    public let missions: DashboardSection<DashboardMission>
    public let scheduled: DashboardSection<DashboardScheduledItem>
    public let tracked: [DashboardTrackedSource]
    /// Optional provider extension point. The app can render this after Missions without another fetch.
    public let memory: ProjectMemorySummary?
    public let recent: DashboardSection<DashboardRecentItem>

    public init(
        projectId: String, summary: ProjectDashboardSummary = .init(),
        needsYou: DashboardSection<DashboardNeedsYouItem> = .init(total: 0, items: []),
        working: DashboardSection<DashboardWorkingItem> = .init(total: 0, items: []),
        pullRequests: DashboardSection<DashboardPullRequest> = .init(total: 0, items: []),
        missions: DashboardSection<DashboardMission> = .init(total: 0, items: []),
        scheduled: DashboardSection<DashboardScheduledItem> = .init(total: 0, items: []),
        tracked: [DashboardTrackedSource] = [],
        memory: ProjectMemorySummary? = nil,
        recent: DashboardSection<DashboardRecentItem> = .init(total: 0, items: [])
    ) {
        self.projectId = projectId
        self.summary = summary
        self.needsYou = needsYou
        self.working = working
        self.pullRequests = pullRequests
        self.missions = missions
        self.scheduled = scheduled
        self.tracked = tracked
        self.memory = memory
        self.recent = recent
    }
}

/// Sidebar counts for one project. Same figures as the dashboard summary.
public struct ProjectDashboardCount: Codable, Equatable, Sendable {
    public let working: Int
    public let needsYou: Int
    /// Open tracked items the Inbox lists (Linear and Slack, without hidden labels).
    public let tracked: Int
    public let needsYouReasons: [String: Int]?

    public init(working: Int = 0, needsYou: Int = 0, tracked: Int = 0, needsYouReasons: [String: Int]? = nil) {
        self.working = working
        self.needsYou = needsYou
        self.tracked = tracked
        self.needsYouReasons = needsYouReasons
    }

    private enum CodingKeys: String, CodingKey { case working, needsYou, tracked, needsYouReasons }

    /// pilotd omits `tracked` when it is 0.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        working = try container.decode(Int.self, forKey: .working)
        needsYou = try container.decode(Int.self, forKey: .needsYou)
        tracked = try container.decodeIfPresent(Int.self, forKey: .tracked) ?? 0
        needsYouReasons = try container.decodeIfPresent([String: Int].self, forKey: .needsYouReasons)
    }
}

/// GET /api/dashboard/counts and WS `dashboard.counts`. Projects with neither count are omitted.
public struct ProjectDashboardCounts: Codable, Equatable, Sendable {
    public let projects: [String: ProjectDashboardCount]

    public init(projects: [String: ProjectDashboardCount] = [:]) {
        self.projects = projects
    }

    public func counts(for projectId: String) -> ProjectDashboardCount {
        projects[projectId] ?? ProjectDashboardCount()
    }
}

/// POST /api/reviews: the user has seen these results. Marks only move forward; at most 1000 per request.
public struct ReviewRequest: Codable, Equatable, Sendable {
    public struct Mark: Codable, Equatable, Sendable {
        public let sessionId: String
        public let outcomeAt: Double

        public init(sessionId: String, outcomeAt: Double) {
            self.sessionId = sessionId
            self.outcomeAt = outcomeAt
        }
    }

    public static let maxMarks = 1000
    public let marks: [Mark]

    public init(marks: [Mark]) {
        self.marks = marks
    }
}
