import Foundation

/// Global Pi scope. nil means absent. [] is preserved on read; both mean all authenticated models.
public struct ModelScope: Codable, Equatable, Sendable {
    public let enabledModels: [String]?
    public let allModels: Bool
    public let scopeHash: String
    public let resolution: [ModelScopePatternResolution]
    public let candidates: [ModelScopeCandidate]
    /// Read-only, only requested with projectId/cwd. nil also covers an absent project override.
    public let projectOverride: [String]?

    public init(enabledModels: [String]?, allModels: Bool, scopeHash: String,
                resolution: [ModelScopePatternResolution], candidates: [ModelScopeCandidate],
                projectOverride: [String]? = nil) {
        self.enabledModels = enabledModels
        self.allModels = allModels
        self.scopeHash = scopeHash
        self.resolution = resolution
        self.candidates = candidates
        self.projectOverride = projectOverride
    }
}

public struct ModelScopeCandidate: Codable, Equatable, Sendable {
    public let id: String
    public let provider: String
    public let name: String

    public init(id: String, provider: String, name: String) {
        self.id = id
        self.provider = provider
        self.name = name
    }
}

public struct ModelScopePatternResolution: Codable, Equatable, Sendable {
    public let pattern: String
    public let matches: [String]
    public let unresolved: ModelScopeUnresolvedReason?

    public init(pattern: String, matches: [String], unresolved: ModelScopeUnresolvedReason? = nil) {
        self.pattern = pattern
        self.matches = matches
        self.unresolved = unresolved
    }
}

public enum ModelScopeUnresolvedReason: String, Codable, Sendable {
    case unknown
    case providerNotLoggedIn = "provider-not-logged-in"
}

public struct ModelScopeUpdateRequest: Codable, Equatable, Sendable {
    public let enabledModels: [String]?
    public let expectedHash: String

    public init(enabledModels: [String]?, expectedHash: String) {
        self.enabledModels = enabledModels
        self.expectedHash = expectedHash
    }

    // nil is an explicit reset, not an omitted field. The server requires enabledModels.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let enabledModels {
            try container.encode(enabledModels, forKey: .enabledModels)
        } else {
            try container.encodeNil(forKey: .enabledModels)
        }
        try container.encode(expectedHash, forKey: .expectedHash)
    }
}

/// Changed responses carry the GET snapshot; value-idempotent responses contain only changed/scopeHash.
public enum ModelScopeUpdateResponse: Decodable, Equatable, Sendable {
    case unchanged(scopeHash: String)
    case changed(ModelScope)

    private enum CodingKeys: String, CodingKey { case changed, scopeHash }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if try container.decode(Bool.self, forKey: .changed) {
            self = .changed(try ModelScope(from: decoder))
        } else {
            self = .unchanged(scopeHash: try container.decode(String.self, forKey: .scopeHash))
        }
    }
}

public struct ModelScopeConflict: Codable, Equatable, Sendable {
    public let error: String
    public let scopeHash: String
    public let enabledModels: [String]?

    public init(error: String = "scope_conflict", scopeHash: String, enabledModels: [String]?) {
        self.error = error
        self.scopeHash = scopeHash
        self.enabledModels = enabledModels
    }
}

public struct ModelScopeError: Codable, Equatable, Sendable {
    public let error: ModelScopeErrorCode

    public init(error: ModelScopeErrorCode) {
        self.error = error
    }
}

public enum ModelScopeErrorCode: String, Codable, Sendable {
    case readOnly = "read_only"
    case settingsUnreadable = "settings_unreadable"
    case invalidScope = "invalid_scope"
    case nativeActionRequired = "native_action_required"
    case modelScopeUnavailable = "model_scope_unavailable"
}
