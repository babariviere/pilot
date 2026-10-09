import Foundation

/// POST /api/update/prepare: a short quiescence lease, only granted when agents are idle.
public struct UpdatePreparation: Codable, Sendable {
    public let ready: Bool
}

public enum ChatMode: String, Codable, Hashable, Sendable {
    case build
    case ask
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
    public let model: String?
    /// Effective thinking level pinned for this chat. Omitted by older daemons.
    public let thinking: String?
    public let usage: SessionUsage?
    /// Named background subagents in spawn order. Omitted when the session has none.
    public let subagents: [SessionSubagent]?
    /// Mission this chat belongs to. Omitted when it has none, or by older daemons.
    public let missionId: String?
    public let error: String?
    public let outcome: SessionOutcome?
    /// Stable completion version, in milliseconds. Unlike updatedAt, survives parking.
    public let outcomeAt: Double?
    public let outcomeReason: String?
    public let pullRequest: SessionPullRequest?
    /// Every PR the session opened, the current branch's first. Omitted when none, or by older daemons.
    public let pullRequests: [SessionPullRequest]?
    /// Every branch or bookmark the session created or used, the current one first. Omitted when none, or by older daemons.
    public let branches: [String]?
    /// A lookup failed. Any retained pull request is last-known, not a fresh result.
    public let pullRequestError: String?

    public var isWorking: Bool { state == "working" || state == "starting" }
    public var effectiveMode: ChatMode { mode ?? .build }
    public var isAsk: Bool { effectiveMode == .ask }
    public var workspaceLabel: String {
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
        if isAsk { return sourceBranch.map { "origin/\($0)" } ?? "Current checkout" }
        return branch ?? sourceBranch.map { "origin/\($0)" }
            ?? (workspace == .clone ? "Default base" : workspace == .direct ? "Current checkout" : "Source unavailable")
    }
    public var workspaceHelp: String {
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
    /// Visible state eligibility. The daemon also rejects un-stopped durable work after a failure.
    public var canArchive: Bool { !isArchived && !isWorking }

    public init(
        id: String, title: String, cwd: String, projectId: String? = nil, branch: String? = nil, createdAt: Double,
        updatedAt: Double, state: String, model: String? = nil, error: String? = nil, usage: SessionUsage? = nil,
        outcome: SessionOutcome? = nil, outcomeAt: Double? = nil, outcomeReason: String? = nil,
        pullRequest: SessionPullRequest? = nil, pullRequestError: String? = nil,
        pullRequests: [SessionPullRequest]? = nil,
        archivedAt: Double? = nil, sessionPath: String? = nil, thinking: String? = nil,
        mode: ChatMode? = nil, sourceBranch: String? = nil, sourceCommit: String? = nil, workspace: WorkspaceMode? = nil,
        lastUserMessageAt: Double? = nil,
        workspaceStorage: WorkspaceStorage? = nil, workspaceReclaimedAt: Double? = nil, workspaceCleanupError: String? = nil,
        subagents: [SessionSubagent]? = nil, pinned: Bool? = nil, missionId: String? = nil,
        branches: [String]? = nil
    ) {
        self.id = id
        self.title = title
        self.cwd = cwd
        self.sessionPath = sessionPath
        self.mode = mode
        self.workspace = workspace
        self.workspaceStorage = workspaceStorage
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
        self.model = model
        self.thinking = thinking
        self.usage = usage
        self.subagents = subagents
        self.missionId = missionId
        self.error = error
        self.outcome = outcome
        self.outcomeAt = outcomeAt
        self.outcomeReason = outcomeReason
        self.pullRequest = pullRequest
        self.pullRequests = pullRequests
        self.branches = branches
        self.pullRequestError = pullRequestError
    }
}

public extension Collection where Element == SessionSummary {
    var unarchivedSessions: [SessionSummary] { filter { !$0.isArchived } }
    var archivedSessions: [SessionSummary] { filter(\.isArchived) }
}

public struct SessionUsage: Codable, Equatable, Hashable, Sendable {
    public let context: ContextUsage?
    public let subscription: SubscriptionUsage?

    public init(context: ContextUsage? = nil, subscription: SubscriptionUsage? = nil) {
        self.context = context
        self.subscription = subscription
    }
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
    public let createdAt: Double

    public var usesPrivateClones: Bool { workspace != "direct" }
    public var effectiveRequirePullRequest: Bool { requirePullRequest ?? true }

    public init(
        id: String, name: String, path: String, model: String? = nil, workspace: String? = nil,
        requirePullRequest: Bool? = nil, createdAt: Double
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.model = model
        self.workspace = workspace
        self.requirePullRequest = requirePullRequest
        self.createdAt = createdAt
    }
}

/// POST /api/projects; PATCH sends only the fields to change (an empty model clears it).
public struct ProjectRequest: Codable, Sendable {
    public var path: String?
    public var name: String?
    public var model: String?
    public var workspace: String?
    public var requirePullRequest: Bool?

    public init(
        path: String? = nil, name: String? = nil, model: String? = nil, workspace: String? = nil,
        requirePullRequest: Bool? = nil
    ) {
        self.path = path
        self.name = name
        self.model = model
        self.workspace = workspace
        self.requirePullRequest = requirePullRequest
    }
}

public enum DeliveryMode: String, Codable, Hashable, Sendable {
    case steer
    case followUp
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
        missionId: String? = nil
    ) {
        self.missionId = missionId
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

/// POST /api/sessions/:id/model. Only idle chats can change their pinned model.
public struct ChangeModelRequest: Codable, Sendable {
    public let model: String
    public let thinking: String?

    public init(model: String, thinking: String? = nil) {
        self.model = model
        self.thinking = thinking
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

/// DELETE /api/sessions/:id/queue/:submissionId. Only withdraws a still-queued input.
public struct RemoveQueuedMessageResponse: Codable, Sendable {
    public let ok: Bool
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
