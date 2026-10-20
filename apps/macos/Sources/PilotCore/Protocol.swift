import Foundation

/// Update preparation. The pause endpoint drains tools and identifies its daemon process.
public struct UpdatePreparation: Codable, Sendable {
    public var processId: Int32?
    public let ready: Bool
}

/// POST /api/sessions/:id/pull-requests. Returns SessionSummary.
public struct BindPullRequestRequest: Codable, Equatable, Sendable {
    /// GitHub PR URL, or a positive number (123 or #123, no leading zero) in the project's GitHub upstream.
    public let url: String
    /// Optional mission task ID or number to disambiguate the owning task.
    public let taskId: String?

    public init(url: String, taskId: String? = nil) {
        self.url = url
        self.taskId = taskId
    }
}

/// DELETE /api/sessions/:id/pull-requests. Detaches the PR from the chat; returns SessionSummary.
public struct UnbindPullRequestRequest: Codable, Equatable, Sendable {
    public let url: String

    public init(url: String) {
        self.url = url
    }
}

/// DELETE /api/sessions/:id/branches. Stops tracking a branch that has no PR; returns SessionSummary.
public struct DetachBranchRequest: Codable, Equatable, Sendable {
    public let branch: String

    public init(branch: String) {
        self.branch = branch
    }
}

public enum ChatMode: String, Codable, Hashable, Sendable {
    case build
    case ask
}

public enum SessionRole: String, Codable, Hashable, Sendable {
    case diagnostics
}

public enum DiagnosticScope: String, Codable, Hashable, Sendable {
    case app
}

public enum WorkspaceMode: String, Codable, Hashable, Sendable {
    case clone
    case direct
}

public enum WorkspaceStorage: String, Codable, Sendable {
    case shared
}

/// Mirrors packages/protocol. Keep both sides in sync.
public struct SessionSummary: Codable, Identifiable, Equatable, Hashable, Sendable {
    public var permissionUpgradeRequest: PermissionUpgradeRequest? = nil
    public var controlStart: ControlStartBudget? = nil
    /// The single project-less control chat. Its tools, not a workspace, perform orchestration.
    public var control: Bool? = nil
    /// On-demand operational specialist with a runtime-enforced read-only tool profile.
    public var role: SessionRole? = nil
    /// Explicit app/host scope with no attached chat or transcript grant.
    public var diagnosticScope: DiagnosticScope? = nil
    /// Exact chat this specialist may inspect without waking or changing it.
    public var diagnosticTargetId: String? = nil
    /// Canonical host-qualified form of the admitted target.
    public var diagnosticTarget: DiagnosticTargetReference? = nil
    /// Explicit grant for bounded read-only target history. Nil means operational evidence only.
    public var diagnosticHistoryAccess: Bool? = nil
    /// Latest bounded specialist-authored repair suggestion. It cannot execute a repair.
    public var diagnosticRepairProposal: DiagnosticRepairProposal? = nil
    public var diagnosticHost: HostRef? = nil
    public let id: String
    public let title: String
    public let cwd: String
    /// Session storage directory containing metadata and durable history, not the working directory.
    public let sessionPath: String?
    public let projectId: String?
    public let mode: ChatMode?
    public let workspace: WorkspaceMode?
    /// Nil for legacy clones and direct checkouts.
    public let workspaceStorage: WorkspaceStorage?
    public let workspaceBase: String?
    public let workspaceUpdatedAt: Double?
    public let workspaceBehind: String?
    /// Epoch milliseconds when the working directory was reclaimed; restored from its pinned jj snapshot on resume.
    public let workspaceReclaimedAt: Double?
    public let workspaceCleanupError: String?
    public let sourceBranch: String?
    public let sourceCommit: String?
    /// The session's own branch or task bookmark, when it runs in an isolated workspace.
    public let branch: String?
    public let createdAt: Double
    public let updatedAt: Double
    /// Latest user submission, epoch milliseconds. Stable across metadata/PR polling.
    public let lastUserMessageAt: Double?
    /// Epoch milliseconds; nil means the chat is not archived. History is retained with recoverable jj snapshots.
    public let archivedAt: Double?
    /// Sorts first and prevents automatic archiving. Omitted by older daemons, meaning unpinned.
    public let pinned: Bool?
    public let state: String
    /// Daemon-derived user-visible work, including live jobs and their pending follow-up.
    public let working: Bool?
    /// Work paused by the Mac sleep policy. Omitted by older daemons.
    public var sleepPaused: Bool? = nil
    /// Model work waiting for daemon-confirmed internet connectivity.
    public var offlinePaused: Bool? = nil
    /// A provider window reached its usage limit. Omitted when nothing is held, or by older daemons.
    public var subscriptionPause: SubscriptionPause? = nil
    /// The chat this one continues after a switch to another provider's model.
    public var continuationOf: String? = nil
    /// The chat that took over this one's work. Set means this chat is read-only and never resumes.
    public var continuedTo: String? = nil
    /// Slack message or Linear ticket the chat was started from or linked to in triage. Omitted when none,
    /// or by older daemons.
    public var trackedSource: SessionTrackedSource? = nil
    /// Worker startup failed. Retry reloads it without replacing queued messages or history.
    public let canRetryStartup: Bool?
    /// Live jobs owned by this worker. Nil when none.
    public let runningJobs: [SessionJob]?
    /// Live user-only attention, independent of the kernel state and outcome.
    public let attentionReason: NeedsYouReason?
    public let attentionAt: Double?
    /// A follow-up message is scheduled for this chat, so it waits on that schedule rather than the user and leaves
    /// Needs you (live reasons excepted). Omitted when none, or by older daemons.
    public var scheduledMessage: Bool? = nil
    public let model: String?
    /// Effective thinking level pinned for this chat. Omitted by older daemons.
    public let thinking: String?
    public let usage: SessionUsage?
    /// Named background subagents in spawn order. Omitted when the session has none.
    public let subagents: [SessionSubagent]?
    /// Mission this chat belongs to. Omitted when it has none, or by older daemons.
    public let missionId: String?
    /// Daemon-owned active role. Omitted by older daemons or when terminal-PR rules apply normally.
    public let missionCoordinator: Bool?
    public let activeMissionCoordinator: Bool?
    public let error: String?
    public let outcome: SessionOutcome?
    /// Stable completion version, in milliseconds. Unlike updatedAt, survives parking.
    public let outcomeAt: Double?
    /// Bounded, redacted failure diagnostic, including the failing step and available causes.
    public let outcomeReason: String?
    public let pullRequest: SessionPullRequest?
    /// Every discovered or explicitly bound PR associated with the session, primary first. Omitted when none, or by older daemons.
    public let pullRequests: [SessionPullRequest]?
    /// URLs explicitly bound to this chat from the Changes pane or by the coordinator, excluding detached ones.
    /// Their head can be a branch the chat never used. Omitted when none, or by older daemons.
    public let boundPullRequests: [String]?
    /// Every branch or bookmark the session created or used, the current one first. Omitted when none, or by older daemons.
    public let branches: [String]?
    /// A lookup failed. Any retained pull request is last-known, not a fresh result.
    public let pullRequestError: String?
    /// Conversation attempts from retry, edit and restore, oldest first. Omitted while there is only the original.
    public let attempts: [SessionAttempt]?
    /// The workspace has work no PR carries, so terminal-PR rules do not apply. Omitted when none, or by older daemons.
    public let unpublishedWork: Bool?

    /// pilotd already reports `working: false` while a usage pause holds the main run with nothing else running.
    public var isWorking: Bool { sleepPaused != true && offlinePaused != true && (working ?? (state == "working" || state == "starting" || !(runningJobs ?? []).isEmpty)) }
    public var effectiveMode: ChatMode { mode ?? .build }
    public var isAsk: Bool { effectiveMode == .ask }
    public var isDiagnosticsSpecialist: Bool { role == .diagnostics }
    public var workspaceLabel: String {
        if isMissionCoordinator { return "Read-only main view" }
        if isAsk { return "Read-only · no isolated workspace" }
        if workspaceReclaimedAt != nil { return "Archived workspace (restored on resume)" }
        if workspaceStorage == .shared { return "Shared jj workspace" }
        switch workspace {
        case .clone: return "Isolated workspace"
        case .direct: return "Current checkout"
        case nil: return branch == nil ? "Build workspace" : "Isolated workspace"
        }
    }
    public var sourceLabel: String {
        if isMissionCoordinator { return "Current main" }
        if isAsk { return sourceBranch.map { "origin/\($0)" } ?? "Current checkout" }
        return branch ?? sourceBranch.map { "origin/\($0)" }
            ?? (workspace == .clone ? "Default base" : workspace == .direct ? "Current checkout" : "Source unavailable")
    }
    public var workspaceHelp: String {
        if isMissionCoordinator {
            return "Shared read-only source, updated after project fetches. Code changes and verification belong in member chats. Temporary files live in this chat's scratch folder until archive."
        }
        if isAsk {
            return "Ask can read and discuss this source, but cannot modify files, run a terminal, or publish. No isolated workspace is created.\(sourceCommit.map { "\nPinned source commit: \($0)" } ?? "")"
        }
        var help = "Build can make changes in this chat's workspace."
        if workspaceStorage == .shared {
            help += "\nThis working copy is isolated from your checkout, but repository history and bookmarks are shared with sibling sessions."
        }
        if workspaceReclaimedAt != nil {
            help += "\nThe archived working directory was reclaimed. Resume restores it from its pinned jj snapshot before work continues."
        }
        if let workspaceCleanupError {
            help += "\nWorkspace cleanup failed: \(workspaceCleanupError)"
        }
        return help
    }
    public var isArchived: Bool { archivedAt != nil }
    public var isPinned: Bool { pinned ?? false }
    /// The one global control chat (`ControlChatIdentity`). It lists apart from other chats and stays pinned.
    public var isControl: Bool { control ?? false }
    /// pilotd keeps the control chat pinned and rejects unpinning it.
    public var canChangePin: Bool { !isControl }
    public var isMissionCoordinator: Bool { missionCoordinator ?? isActiveMissionCoordinator }
    public var supportsChanges: Bool { !isAsk && !isMissionCoordinator }
    public var isActiveMissionCoordinator: Bool { activeMissionCoordinator ?? false }
    public func workspaceBaseLabel(now: Date = Date()) -> String? {
        guard isMissionCoordinator, let workspaceBase else { return nil }
        let prefix = workspaceBehind == nil ? "on" : "behind"
        let base = "\(prefix) \(sourceBranch ?? "main") @ \(workspaceBase.prefix(8))"
        guard let workspaceUpdatedAt else { return "\(base), not yet updated" }
        let minutes = max(0, Int((now.timeIntervalSince1970 * 1000 - workspaceUpdatedAt) / 60_000))
        return "\(base), updated \(minutes) min ago"
    }
    public var hasUnpublishedWork: Bool { unpublishedWork ?? false }
    /// Visible state eligibility. The daemon also rejects un-stopped durable work after a failure.
    /// The control chat is never archived, so it can never be deleted either.
    public var canArchive: Bool { !isControl && !isArchived && !isWorking }

    public init(
        id: String, title: String, cwd: String, projectId: String? = nil, branch: String? = nil, createdAt: Double,
        updatedAt: Double, state: String, model: String? = nil, error: String? = nil, usage: SessionUsage? = nil,
        outcome: SessionOutcome? = nil, outcomeAt: Double? = nil, outcomeReason: String? = nil,
        pullRequest: SessionPullRequest? = nil, pullRequestError: String? = nil,
        pullRequests: [SessionPullRequest]? = nil,
        boundPullRequests: [String]? = nil,
        archivedAt: Double? = nil, sessionPath: String? = nil, thinking: String? = nil,
        mode: ChatMode? = nil, sourceBranch: String? = nil, sourceCommit: String? = nil, workspace: WorkspaceMode? = nil,
        lastUserMessageAt: Double? = nil,
        workspaceStorage: WorkspaceStorage? = nil, workspaceReclaimedAt: Double? = nil, workspaceCleanupError: String? = nil,
        subagents: [SessionSubagent]? = nil, pinned: Bool? = nil, missionId: String? = nil,
        branches: [String]? = nil, missionCoordinator: Bool? = nil, activeMissionCoordinator: Bool? = nil, attempts: [SessionAttempt]? = nil,
        unpublishedWork: Bool? = nil, workspaceBase: String? = nil, workspaceUpdatedAt: Double? = nil,
        workspaceBehind: String? = nil, runningJobs: [SessionJob]? = nil, canRetryStartup: Bool? = nil,
        working: Bool? = nil, attentionReason: NeedsYouReason? = nil, attentionAt: Double? = nil,
        role: SessionRole? = nil, diagnosticScope: DiagnosticScope? = nil, diagnosticTargetId: String? = nil,
        diagnosticTarget: DiagnosticTargetReference? = nil, diagnosticHistoryAccess: Bool? = nil,
        diagnosticRepairProposal: DiagnosticRepairProposal? = nil
    ) {
        self.id = id
        self.role = role
        self.diagnosticScope = diagnosticScope
        self.diagnosticTargetId = diagnosticTargetId
        self.diagnosticTarget = diagnosticTarget
        self.diagnosticHistoryAccess = diagnosticHistoryAccess
        self.diagnosticRepairProposal = diagnosticRepairProposal
        self.title = title
        self.cwd = cwd
        self.sessionPath = sessionPath
        self.mode = mode
        self.workspace = workspace
        self.workspaceStorage = workspaceStorage
        self.workspaceBase = workspaceBase
        self.workspaceUpdatedAt = workspaceUpdatedAt
        self.workspaceBehind = workspaceBehind
        self.workspaceReclaimedAt = workspaceReclaimedAt
        self.workspaceCleanupError = workspaceCleanupError
        self.sourceBranch = sourceBranch
        self.sourceCommit = sourceCommit
        self.projectId = projectId
        self.branch = branch
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastUserMessageAt = lastUserMessageAt
        self.archivedAt = archivedAt
        self.pinned = pinned
        self.state = state
        self.working = working
        self.canRetryStartup = canRetryStartup
        self.runningJobs = runningJobs
        self.attentionReason = attentionReason
        self.attentionAt = attentionAt
        self.model = model
        self.thinking = thinking
        self.usage = usage
        self.subagents = subagents
        self.missionId = missionId
        self.missionCoordinator = missionCoordinator
        self.activeMissionCoordinator = activeMissionCoordinator
        self.error = error
        self.outcome = outcome
        self.outcomeAt = outcomeAt
        self.outcomeReason = outcomeReason
        self.pullRequest = pullRequest
        self.pullRequests = pullRequests
        self.boundPullRequests = boundPullRequests
        self.branches = branches
        self.pullRequestError = pullRequestError
        self.attempts = attempts
        self.unpublishedWork = unpublishedWork
    }
}

public extension Collection where Element == SessionSummary {
    var unarchivedSessions: [SessionSummary] { filter { !$0.isArchived } }
    var archivedSessions: [SessionSummary] { filter(\.isArchived) }
}

public struct SessionUsage: Codable, Equatable, Hashable, Sendable {
    public let context: ContextUsage?
    public let subscription: SubscriptionUsage?
    public let ai: AIUsageAccounting?

    public init(context: ContextUsage? = nil, subscription: SubscriptionUsage? = nil,
                ai: AIUsageAccounting? = nil) {
        self.context = context
        self.subscription = subscription
        self.ai = ai
    }
}

public struct AIUsageAccounting: Codable, Equatable, Hashable, Sendable {
    public let observedAt: Double
    public let direct: AIUsageScope
    public let child: AIUsageScope
    public let time: AIUsageTime
    public let efficiency: AIUsageEfficiency?
}

public struct AIUsageScope: Codable, Equatable, Hashable, Sendable {
    public let tokens: AIUsageTokens
    public let cost: AIUsageCost
    public let activity: AIUsageActivity
}

public struct AIUsageTokens: Codable, Equatable, Hashable, Sendable {
    public let input: Double
    public let output: Double
    public let cacheRead: Double
    public let cacheWrite: Double
    public let reasoning: Double?
    public let reasoningStatus: String
}

public struct AIUsageCost: Codable, Equatable, Hashable, Sendable {
    public let estimateStatus: String
    public let estimatedUsdMicros: Double?
    public let pricingRevision: String?
    public let billedStatus: String
    public let billedUsdMicros: Double?
    public let subscriptionCoverage: String
}

public struct AIUsageActivity: Codable, Equatable, Hashable, Sendable {
    public let kind: String
    public let count: Double
    public let success: Double
    public let failure: Double
    public let cancelled: Double
    public let usageReports: Double
    public let providerAttemptsObserved: Double
    public let requestRetriesObserved: Double?
    public let elapsedMsObserved: Double
    public let activeMsObserved: Double
    public let outcomeCoverage: String
    public let timingCoverage: String
}

public struct AIUsageEfficiency: Codable, Equatable, Hashable, Sendable {
    public let direct: AIUsageEfficiencyScope
    public let child: AIUsageEfficiencyScope
    public let context: AIContextEfficiency?
    public let compaction: AICompactionEfficiency
    public let relaunch: AIRelaunchEfficiency
}

public struct AIUsageEfficiencyScope: Codable, Equatable, Hashable, Sendable {
    public let observations: Double
    public let inputTokens: Double
    public let cacheReadTokens: Double
    public let cacheWriteTokens: Double
    public let cacheEfficiencyNumerator: Double
    public let cacheEfficiencyDenominator: Double
    public let coverage: String
}

public struct AIContextEfficiency: Codable, Equatable, Hashable, Sendable {
    public let observedAt: Double
    public let tokens: Double
    public let contextWindow: Double
    public let headroomTokens: Double
    public let percent: Double
    public let coverage: String
}

public struct AICompactionEfficiency: Codable, Equatable, Hashable, Sendable {
    public let count: Double
    public let pairedMeasurements: Double
    public let beforeTokens: Double
    public let afterTokens: Double
    public let tokensRemoved: Double
    public let timingStatus: String
    public let coverage: String
}

public struct AIRelaunchEfficiency: Codable, Equatable, Hashable, Sendable {
    public let count: Double
    public let reasons: [String: Double]
    public let lastObservedAt: Double?
    public let contextPreparationsObserved: Double
    public let contextTokensPrepared: Double
    public let estimatedCostStatus: String
    public let coverage: String
}

public struct AIUsageTime: Codable, Equatable, Hashable, Sendable {
    public let elapsedMs: Double
    public let activeMs: Double
    public let pausedMs: Double
    public let idleMs: Double
    public let coverage: String
}

public struct ContextUsage: Codable, Equatable, Hashable, Sendable {
    public let tokens: Double?
    public let contextWindow: Double
    public let percent: Double?

    public init(tokens: Double? = nil, contextWindow: Double, percent: Double? = nil) {
        self.tokens = tokens
        self.contextWindow = contextWindow
        self.percent = percent
    }
}

public enum SubscriptionProvider: String, Codable, Hashable, Sendable {
    case anthropic
    case openai
}

public struct SubscriptionWindow: Codable, Equatable, Hashable, Sendable {
    public let label: String
    public let usedPercent: Double
    /// ISO 8601 reset timestamp.
    public let resetsAt: String?

    public init(label: String, usedPercent: Double, resetsAt: String? = nil) {
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }
}

public struct SubscriptionUsage: Codable, Equatable, Hashable, Sendable {
    /// Epoch milliseconds of the provider snapshot, not its delivery time.
    public let fetchedAt: Double
    public let provider: SubscriptionProvider?
    public let windows: [SubscriptionWindow]
    public let error: String?

    public init(fetchedAt: Double, provider: SubscriptionProvider? = nil, windows: [SubscriptionWindow], error: String? = nil) {
        self.fetchedAt = fetchedAt
        self.provider = provider
        self.windows = windows
        self.error = error
    }
}

public struct Project: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let path: String
    public let model: String?
    /// "clone" (default, nil) or "direct".
    public let workspace: String?
    /// Whether publishing requires a pull request. Omitted by older daemons; defaults to true.
    public let requirePullRequest: Bool?
    public let tracking: ProjectTrackingConfig?
    /// Environment profile. Edited through PUT /api/projects/:id/environment only.
    public let environment: ProjectEnvironment?
    /// This host's own environment layer, never synced. Edited through PUT /api/projects/:id/environment/override.
    public let environmentOverride: ProjectEnvironmentOverride?
    public let createdAt: Double

    public var usesPrivateClones: Bool { workspace != "direct" }
    public var effectiveRequirePullRequest: Bool { requirePullRequest ?? true }

    public init(
        id: String, name: String, path: String, model: String? = nil, workspace: String? = nil,
        requirePullRequest: Bool? = nil, tracking: ProjectTrackingConfig? = nil,
        environment: ProjectEnvironment? = nil, environmentOverride: ProjectEnvironmentOverride? = nil,
        createdAt: Double
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.model = model
        self.workspace = workspace
        self.requirePullRequest = requirePullRequest
        self.tracking = tracking
        self.environment = environment
        self.environmentOverride = environmentOverride
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, path, model, workspace, requirePullRequest, tracking, environment, environmentOverride, createdAt
    }

    /// A profile from a newer daemon that this app cannot read never hides the project itself.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        path = try container.decode(String.self, forKey: .path)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        workspace = try container.decodeIfPresent(String.self, forKey: .workspace)
        requirePullRequest = try container.decodeIfPresent(Bool.self, forKey: .requirePullRequest)
        tracking = try container.decodeIfPresent(ProjectTrackingConfig.self, forKey: .tracking)
        environment = try? container.decodeIfPresent(ProjectEnvironment.self, forKey: .environment)
        environmentOverride = try? container.decodeIfPresent(ProjectEnvironmentOverride.self, forKey: .environmentOverride)
        createdAt = try container.decode(Double.self, forKey: .createdAt)
    }
}

/// GET /api/projects/:id/github. Resolved on demand on the project's host.
public struct ProjectGitHubRepository: Codable, Equatable, Sendable {
    public let url: String

    public var browserURL: URL? {
        guard let parts = URLComponents(string: url), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.split(separator: "/").count == 2 else { return nil }
        return parts.url
    }

    public init(url: String) { self.url = url }
}

/// Read-only, sanitized origin identity. Never a credentialed URL or sharing authorization.
public struct ProjectOrigin: Codable, Equatable, Sendable {
    public let identity: String?
    public init(identity: String?) { self.identity = identity }
}

/// POST /api/projects; PATCH sends only the fields to change (an empty model clears it).
public struct ProjectRequest: Codable, Sendable {
    public var path: String?
    public var name: String?
    public var model: String?
    public var workspace: String?
    public var requirePullRequest: Bool?
    public var tracking: ProjectTrackingConfig?

    public init(
        path: String? = nil, name: String? = nil, model: String? = nil, workspace: String? = nil,
        requirePullRequest: Bool? = nil, tracking: ProjectTrackingConfig? = nil
    ) {
        self.path = path
        self.name = name
        self.model = model
        self.workspace = workspace
        self.requirePullRequest = requirePullRequest
        self.tracking = tracking
    }
}

public enum DeliveryMode: String, Codable, Hashable, Sendable {
    case steer
    case followUp
}

/// Source of input the user did not type. Automatic user entries carry it; typed ones omit it.
public enum InputOrigin: String, Codable, Hashable, Sendable {
    case job
    case subagent
    case `extension`
    case coordinator
    case mission
    case pullRequest
    /// New replies in a Slack thread the chat was waiting on.
    case slack
    case control
    case watch
}

/// One selectable model from the user's pi scope.
public struct ModelOption: Codable, Identifiable, Hashable, Sendable {
    /// "provider/modelId".
    public let id: String
    public let provider: String
    public let name: String
    public let reasoning: Bool?
    public let thinking: String?
    /// Ordered supported levels. Missing capabilities must not invent selectable levels.
    public let thinkingLevels: [String]?

    public init(
        id: String, provider: String, name: String, reasoning: Bool? = nil, thinking: String? = nil,
        thinkingLevels: [String]? = nil
    ) {
        self.id = id
        self.provider = provider
        self.name = name
        self.reasoning = reasoning
        self.thinking = thinking
        self.thinkingLevels = thinkingLevels
    }
}

public struct ModelList: Codable, Equatable, Sendable {
    public let models: [ModelOption]
    public let defaultModel: String?

    public init(models: [ModelOption], defaultModel: String? = nil) {
        self.models = models
        self.defaultModel = defaultModel
    }
}

/// Native-confirmed source authority for a separate Build spawned from a diagnostics proposal.
public struct DiagnosticRepairAdmission: Codable, Equatable, Sendable {
    public let specialistSessionId: String
    public let proposalId: String
    /// Exact target identity admitted to the specialist when it published the proposal.
    public let target: DiagnosticTargetReference?
    public let subject: DiagnosticEvidenceSubject?
    public let binding: DiagnosticRepairProjectBinding?
    public let repairTitle: String?
    /// Native Start repair disclosure was accepted. Absent on older intents, which must not archive.
    public let archiveSpecialistOnStart: Bool?
    public var evidenceSubject: DiagnosticEvidenceSubject? { subject ?? target.map(DiagnosticEvidenceSubject.chat) }

    public init(specialistSessionId: String, proposalId: String, target: DiagnosticTargetReference) {
        self.specialistSessionId = specialistSessionId
        self.proposalId = proposalId
        self.target = target
        subject = nil; binding = nil; repairTitle = nil; archiveSpecialistOnStart = nil
    }

    public init(specialistSessionId: String, proposalId: String, subject: DiagnosticEvidenceSubject,
                binding: DiagnosticRepairProjectBinding?, repairTitle: String, archiveSpecialistOnStart: Bool? = nil) {
        self.specialistSessionId = specialistSessionId; self.proposalId = proposalId
        self.subject = subject; target = subject.target; self.binding = binding; self.repairTitle = repairTitle
        self.archiveSpecialistOnStart = archiveSpecialistOnStart
    }
}

/// GET /api/projects/:id/branches. Only real branches advertised by origin.
public struct RemoteBranchList: Codable, Equatable, Sendable {
    public let branches: [String]
    public let defaultBranch: String?

    public init(branches: [String] = [], defaultBranch: String? = nil) {
        self.branches = branches
        self.defaultBranch = defaultBranch
    }
}

/// Needs a missionId, projectId or cwd (cwd overrides a non-mission project's path).
/// POST returns a durable `starting` session while its workspace and kernel initialize.
public struct SpawnRequest: Codable, Sendable {
    /// Join before the first turn, using the mission's project with no cwd override.
    public var missionId: String?
    /// A host-enforced specialist profile. Omitted for ordinary Build and Ask chats.
    public var role: SessionRole?
    /// Required for chat diagnostics. Mutually exclusive with diagnosticScope.
    public var diagnosticTarget: DiagnosticTargetReference?
    /// Required for app diagnostics. Mutually exclusive with diagnosticTarget.
    public var diagnosticScope: DiagnosticScope?
    /// Explicit grant for bounded target history reads. Omitted for generic no-link Ask about Pilot.
    public var diagnosticHistoryAccess: Bool?
    /// Diagnostics-only hint to title from substantive specialist text instead of the fixed opening instruction.
    public var diagnosticTitleFromReply: Bool?
    /// Native-reviewed proposal authority. Accepted only by a durable repair-create operation.
    public var diagnosticRepair: DiagnosticRepairAdmission?
    public var diagnosticHost: HostRef?
    public var projectId: String?
    public var cwd: String?
    public var message: String
    public var title: String?
    public var model: String?
    public var thinking: String?
    public var mode: ChatMode?
    public var workspace: WorkspaceMode?
    /// Exact origin branch. Ask omission reads current checkout; Build omission uses default base.
    public var baseBranch: String?

    public init(
        projectId: String? = nil, cwd: String? = nil, message: String, title: String? = nil, model: String? = nil,
        thinking: String? = nil, baseBranch: String? = nil, mode: ChatMode? = nil, workspace: WorkspaceMode? = nil,
        missionId: String? = nil, role: SessionRole? = nil, diagnosticTarget: DiagnosticTargetReference? = nil,
        diagnosticScope: DiagnosticScope? = nil,
        diagnosticHost: HostRef? = nil,
        diagnosticHistoryAccess: Bool? = nil, diagnosticTitleFromReply: Bool? = nil,
        diagnosticRepair: DiagnosticRepairAdmission? = nil
    ) {
        self.missionId = missionId
        self.role = role
        self.diagnosticTarget = diagnosticTarget
        self.diagnosticScope = diagnosticScope
        self.diagnosticHost = diagnosticHost
        self.diagnosticHistoryAccess = diagnosticHistoryAccess
        self.diagnosticTitleFromReply = diagnosticTitleFromReply
        self.diagnosticRepair = diagnosticRepair
        self.projectId = projectId
        self.cwd = cwd
        self.message = message
        self.title = title
        self.model = model
        self.thinking = thinking
        self.baseBranch = baseBranch
        self.mode = mode
        self.workspace = workspace
    }
}

public struct SendRequest: Codable, Sendable {
    public var message: String
    public var mode: DeliveryMode
    public var requestId: String?

    public init(message: String, mode: DeliveryMode, requestId: String? = nil) {
        self.message = message
        self.mode = mode
        self.requestId = requestId
    }
}

/// POST /api/sessions/:id/database-access: the user's answer to a db access request.
public struct DatabaseAccessDecision: Codable, Sendable {
    public var id: String
    public var allow: Bool

    public init(id: String, allow: Bool) {
        self.id = id
        self.allow = allow
    }
}

/// A prompt template (`/name`) or skill (`/skill:name`) that the session's kernel expands when sent.
public struct SessionCommand: Codable, Equatable, Sendable {
    public enum Source: String, Codable, Sendable { case prompt, skill }
    /// Invocation name without the leading slash.
    public let name: String
    public let source: Source
    public let description: String?
    public let argumentHint: String?

    public init(name: String, source: Source, description: String? = nil, argumentHint: String? = nil) {
        self.name = name
        self.source = source
        self.description = description
        self.argumentHint = argumentHint
    }
}

/// GET /api/sessions/:id/commands
public struct SessionCommandsResponse: Codable, Sendable {
    public let commands: [SessionCommand]
}

/// A running shell job in the current worker. Handles and logs are runtime-local.
public struct SessionJob: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum State: String, Codable, Sendable { case running }
    public let id: String
    public let name: String
    public let state: State
    public let startedAt: Double
    public let outputPath: String

    public init(id: String, name: String, startedAt: Double, outputPath: String) {
        self.id = id
        self.name = name
        self.state = .running
        self.startedAt = startedAt
        self.outputPath = outputPath
    }

    /// Snapshot elapsed time, updated only on explicit refresh, never by a transcript timer.
    public func elapsed(at milliseconds: Double) -> String {
        let seconds = max(0, (milliseconds - startedAt) / 1000)
        if seconds < 60 { return "\(Int(seconds))s" }
        if seconds < 3600 { return "\(Int(seconds / 60))m \(Int(seconds.truncatingRemainder(dividingBy: 60)))s" }
        return "\(Int(seconds / 3600))h \(Int((seconds / 60).truncatingRemainder(dividingBy: 60)))m"
    }
}

/// GET /api/sessions/:id/jobs. Never reopens a parked worker or starts model work.
public struct SessionJobsResponse: Codable, Sendable {
    public let jobs: [SessionJob]
}

/// POST /api/sessions/:id/compact
public struct CompactRequest: Codable, Sendable {
    public let instructions: String?

    public init(instructions: String?) {
        self.instructions = instructions
    }
}

/// How an attempt started. Mirrors packages/protocol's RewindAction.
public enum RewindAction: String, Codable, Hashable, Sendable {
    case retry
    case edit
    case restore
}

/// Why a conversation attempt was created, including an automatic model-context rebuild.
public enum SessionAttemptReason: String, Codable, Hashable, Sendable {
    case retry
    case edit
    case restore
    case model
}

/// One conversation of a session. The chat shows and continues only its active attempt.
public struct SessionAttempt: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    /// Nil for the original conversation, and for actions this client does not know.
    public let reason: SessionAttemptReason?
    /// Epoch milliseconds. Nil for the original conversation.
    public let createdAt: Double?
    public let preview: String?
    public let active: Bool?

    public var isActive: Bool { active ?? false }

    public init(id: String, reason: SessionAttemptReason? = nil, createdAt: Double? = nil, preview: String? = nil,
                active: Bool? = nil) {
        self.id = id
        self.reason = reason
        self.createdAt = createdAt
        self.preview = preview
        self.active = active
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        // Unknown actions from newer daemons decode as nil rather than failing the whole session.
        let rawReason: String? = try container.decodeIfPresent(String.self, forKey: .reason)
        reason = rawReason.flatMap { SessionAttemptReason(rawValue: $0) }
        createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt)
        preview = try container.decodeIfPresent(String.self, forKey: .preview)
        active = try container.decodeIfPresent(Bool.self, forKey: .active)
    }

    /// Menu label, e.g. "Retry", "Edited: fix the login test".
    public var title: String {
        switch reason {
        case nil: return "Original"
        case .retry: return "Retry"
        case .restore: return "Restored"
        case .model: return "Model changed"
        case .edit:
            guard let preview else { return "Edited" }
            let line: Substring = preview.split(whereSeparator: \.isNewline).first ?? Substring(preview)
            let detail: String = line.count > 48 ? String(line.prefix(47)) + "…" : String(line)
            return "Edited: " + detail
        }
    }
}

/// POST /api/sessions/:id/rewind
public struct RewindRequest: Codable, Sendable {
    public let action: RewindAction
    public let entryId: Int

    public init(action: RewindAction, entryId: Int) {
        self.action = action
        self.entryId = entryId
    }
}

public struct RewindResponse: Codable, Sendable {
    public let session: SessionSummary
    /// Text of the edited message, for the composer.
    public let draft: String?
}

/// POST /api/sessions/:id/stop. `draft` holds the user's own queued messages Stop withdrew, for the composer.
public struct StopResponse: Codable, Sendable {
    public let draft: String?
}

/// POST /api/sessions/:id/model. Only idle chats can change their pinned model.
public struct ChangeModelRequest: Codable, Sendable {
    public let model: String
    public let thinking: String?

    public init(model: String, thinking: String? = nil) {
        self.model = model
        self.thinking = thinking
    }
}

/// POST /api/sessions/:id/title. The daemon trims the title and rejects an empty one.
public struct RenameSessionRequest: Codable, Sendable {
    public let title: String

    public init(title: String) {
        self.title = title
    }
}

public struct ChangedFile: Codable, Identifiable, Equatable, Sendable {
    public var id: String { path }
    public let path: String
    /// "added", "modified", "deleted", "renamed" or "untracked".
    public let status: String
    public let additions: Int
    public let deletions: Int
    public let previousPath: String?

    public init(path: String, status: String, additions: Int, deletions: Int, previousPath: String? = nil) {
        self.path = path
        self.status = status
        self.additions = additions
        self.deletions = deletions
        self.previousPath = previousPath
    }
}

/// PATCH /api/sessions/:id/queue/:submissionId. A nil mode keeps the message's delivery mode.
public struct EditQueuedMessageRequest: Codable, Sendable {
    public let message: String
    public let mode: DeliveryMode?

    public init(message: String, mode: DeliveryMode? = nil) {
        self.message = message
        self.mode = mode
    }
}

/// Send or discard held automatic input. Waiting messages stay read-only.
public struct HeldMessagesResponse: Codable, Sendable {
    public let ok: Bool
}

/// DELETE /api/sessions/:id/queue/:submissionId. Only withdraws a still-queued input.
public struct RemoveQueuedMessageResponse: Codable, Sendable {
    public let ok: Bool
}

/// GET /api/sessions/:id/changes/branch. No changed files or line counts are read.
public struct SessionBranch: Codable, Equatable, Sendable {
    public let branch: String?
    public init(branch: String? = nil) { self.branch = branch }
}

/// GET /api/sessions/:id/changes/summary. No patch content is generated or transferred.
public struct SessionChangeSummary: Codable, Equatable, Sendable {
    public let base: String
    public let branch: String?
    public let fileCount: Int
    /// Omitted by older daemons. Unknown totals must not be displayed as zero.
    public let additions: Int?
    public let deletions: Int?

    public init(base: String, branch: String? = nil, fileCount: Int, additions: Int? = nil, deletions: Int? = nil) {
        self.base = base
        self.branch = branch
        self.fileCount = fileCount
        self.additions = additions
        self.deletions = deletions
    }

    public var fileCountLabel: String { "\(fileCount) file\(fileCount == 1 ? "" : "s")" }
    public var lineStatLabel: String? {
        guard let additions, let deletions else { return nil }
        return "\(additions) lines added, \(deletions) lines deleted"
    }
    public var helpText: String {
        "\(fileCountLabel) changed since \(base), including committed, uncommitted and untracked files."
            + (lineStatLabel.map { "\n\($0). Binary files have no line totals." } ?? "")
    }
}

/// GET /api/sessions/:id/changes
public struct SessionChanges: Codable, Equatable, Sendable {
    public let base: String
    public let branch: String?
    public let files: [ChangedFile]
    public let diff: String
    public let truncated: Bool

    public init(base: String, branch: String? = nil, files: [ChangedFile], diff: String, truncated: Bool = false) {
        self.base = base
        self.branch = branch
        self.files = files
        self.diff = diff
        self.truncated = truncated
    }
}
