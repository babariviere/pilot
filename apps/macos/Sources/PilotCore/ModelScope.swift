import Foundation

/// Host-local Pi scope. nil global scope means all available models; [] also means all in Pi.
public struct ModelScope: Codable, Equatable, Sendable {
    public let enabledModels: [String]?
    public let contentHash: String
    public let projectOverride: [String]?
    public let resolution: [ModelScopePatternResolution]
    public let projectResolution: [ModelScopePatternResolution]?
    public let writable: Bool

    public init(enabledModels: [String]?, contentHash: String, projectOverride: [String]?,
                resolution: [ModelScopePatternResolution], projectResolution: [ModelScopePatternResolution]?,
                writable: Bool) {
        self.enabledModels = enabledModels
        self.contentHash = contentHash
        self.projectOverride = projectOverride
        self.resolution = resolution
        self.projectResolution = projectResolution
        self.writable = writable
    }
}

public struct ModelScopePatternResolution: Codable, Equatable, Sendable {
    public let pattern: String
    public let matchedModelIds: [String]
    public let unresolvedReason: ModelScopeUnresolvedReason?
    public let diagnostics: [String]

    public init(pattern: String, matchedModelIds: [String], unresolvedReason: ModelScopeUnresolvedReason?,
                diagnostics: [String]) {
        self.pattern = pattern
        self.matchedModelIds = matchedModelIds
        self.unresolvedReason = unresolvedReason
        self.diagnostics = diagnostics
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

public struct ModelScopeConflict: Codable, Equatable, Sendable {
    public let currentHash: String
    public let current: [String]?

    public init(currentHash: String, current: [String]?) {
        self.currentHash = currentHash
        self.current = current
    }
}
