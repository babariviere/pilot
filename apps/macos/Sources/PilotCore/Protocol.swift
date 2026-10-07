import Foundation

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
    public let state: String
    public let model: String?
    public let error: String?

    public var isWorking: Bool { state == "working" || state == "starting" }

    public init(
        id: String, title: String, cwd: String, projectId: String? = nil, branch: String? = nil, createdAt: Double,
        updatedAt: Double, state: String, model: String? = nil, error: String? = nil
    ) {
        self.id = id
        self.title = title
        self.cwd = cwd
        self.projectId = projectId
        self.branch = branch
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.state = state
        self.model = model
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
