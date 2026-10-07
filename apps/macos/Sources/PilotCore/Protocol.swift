import Foundation

/// POST /api/update/prepare: a short quiescence lease, only granted when agents are idle.
public struct UpdatePreparation: Codable, Sendable {
    public let ready: Bool
}

/// Mirrors packages/protocol. Keep both sides in sync.
public struct SessionSummary: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let cwd: String
    public let projectId: String?
    /// The session's own branch, when it runs in a private clone.
    public let branch: String?
    public let createdAt: Double
    public let updatedAt: Double
    /// Epoch milliseconds; nil means the chat is not archived. History and workspace are retained.
    public let archivedAt: Double?
    public let state: String
    public let model: String?
    public let usage: SessionUsage?
    public let error: String?
    public let outcome: SessionOutcome?
    /// Stable completion version, in milliseconds. Unlike updatedAt, survives parking.
    public let outcomeAt: Double?
    public let outcomeReason: String?
    public let pullRequest: SessionPullRequest?
    /// A lookup failed. Any retained pull request is last-known, not a fresh result.
    public let pullRequestError: String?

    public var isWorking: Bool { state == "working" || state == "starting" }
    public var isArchived: Bool { archivedAt != nil }
    /// Visible state eligibility. The daemon also rejects un-stopped durable work after a failure.
    public var canArchive: Bool { !isArchived && !isWorking }

    public init(
        id: String, title: String, cwd: String, projectId: String? = nil, branch: String? = nil, createdAt: Double,
        updatedAt: Double, state: String, model: String? = nil, error: String? = nil, usage: SessionUsage? = nil,
        outcome: SessionOutcome? = nil, outcomeAt: Double? = nil, outcomeReason: String? = nil,
        pullRequest: SessionPullRequest? = nil, pullRequestError: String? = nil,
        archivedAt: Double? = nil
    ) {
        self.id = id
        self.title = title
        self.cwd = cwd
        self.projectId = projectId
        self.branch = branch
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.archivedAt = archivedAt
        self.state = state
        self.model = model
        self.usage = usage
        self.error = error
        self.outcome = outcome
        self.outcomeAt = outcomeAt
        self.outcomeReason = outcomeReason
        self.pullRequest = pullRequest
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
    public let createdAt: Double

    public var usesPrivateClones: Bool { workspace != "direct" }

    public init(id: String, name: String, path: String, model: String? = nil, workspace: String? = nil, createdAt: Double) {
        self.id = id
        self.name = name
        self.path = path
        self.model = model
        self.workspace = workspace
        self.createdAt = createdAt
    }
}

/// POST /api/projects; PATCH sends only the fields to change (an empty model clears it).
public struct ProjectRequest: Codable, Sendable {
    public var path: String?
    public var name: String?
    public var model: String?
    public var workspace: String?

    public init(path: String? = nil, name: String? = nil, model: String? = nil, workspace: String? = nil) {
        self.path = path
        self.name = name
        self.model = model
        self.workspace = workspace
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

    public init(id: String, provider: String, name: String, reasoning: Bool? = nil, thinking: String? = nil) {
        self.id = id
        self.provider = provider
        self.name = name
        self.reasoning = reasoning
        self.thinking = thinking
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

/// Needs a projectId, a cwd, or both (cwd overrides the project's path).
/// POST returns a durable `starting` session while its workspace and kernel initialize.
public struct SpawnRequest: Codable, Sendable {
    public var projectId: String?
    public var cwd: String?
    public var message: String
    public var title: String?
    public var model: String?
    public var thinking: String?

    public init(
        projectId: String? = nil, cwd: String? = nil, message: String, title: String? = nil, model: String? = nil,
        thinking: String? = nil
    ) {
        self.projectId = projectId
        self.cwd = cwd
        self.message = message
        self.title = title
        self.model = model
        self.thinking = thinking
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

    public init(model: String) { self.model = model }
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

/// PATCH /api/sessions/:id/queue/:submissionId.
public struct EditQueuedMessageRequest: Codable, Sendable {
    public let message: String

    public init(message: String) { self.message = message }
}

/// DELETE /api/sessions/:id/queue/:submissionId. Only withdraws a still-queued input.
public struct RemoveQueuedMessageResponse: Codable, Sendable {
    public let ok: Bool
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
