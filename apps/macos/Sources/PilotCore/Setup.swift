import Foundation

/// Mirrors `packages/protocol/src/setup.ts`. Never persist private challenges or answers.
public enum SetupMethod: String, Codable, Sendable { case deviceCode = "device_code", manualCode = "manual_code" }
public enum SetupCredentialState: String, Codable, Sendable {
    case missing, configured, reauthenticationRequired = "reauthentication_required"
}
public struct SetupCredentialStatus: Codable, Equatable, Sendable { public let state: SetupCredentialState }
public struct SetupProvider: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let methods: [SetupMethod]
    /// Stored canonical authentication only. Not a provider acceptance check or ambient auth inventory.
    public let credential: SetupCredentialState
}
public struct SetupIntegration: Codable, Equatable, Sendable {
    public let kind: String
    public let state: String
    public let login: String
    public let problem: String
}
public struct SetupReadiness: Codable, Equatable, Sendable {
    public let providers: [SetupProvider]
    public let integrations: [SetupIntegration]
    public let independentCredentials: Bool
}
public struct SetupStartRequest: Codable, Equatable, Sendable {
    public let provider: String
    public let method: SetupMethod
    public init(provider: String, method: SetupMethod) { self.provider = provider; self.method = method }
}
public struct SetupRun: Codable, Equatable, Identifiable, Sendable {
    public enum State: String, Codable, Sendable { case starting, waiting, working, done, failed, cancelled }
    public let id: String
    public let provider: String
    public let method: SetupMethod
    public let state: State
    public let createdAt: Double
    public let expiresAt: Double
    public let reauthenticationRequired: Bool
    public let problem: String?
}
public struct SetupChallenge: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let type: SetupMethod
    public let url: String
    public let userCode: String?
}
public enum SetupServerMessage: Decodable, Equatable, Sendable {
    case state(SetupRun), challenge(SetupChallenge), output(String), error(String)
    private enum CodingKeys: String, CodingKey { case type, run, challenge, data, message }
    public init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        switch try value.decode(String.self, forKey: .type) {
        case "setup.state": self = .state(try value.decode(SetupRun.self, forKey: .run))
        case "setup.challenge": self = .challenge(try value.decode(SetupChallenge.self, forKey: .challenge))
        case "setup.output": self = .output(try value.decode(String.self, forKey: .data))
        case "setup.error": self = .error(try value.decode(String.self, forKey: .message))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: value, debugDescription: "Unknown setup message")
        }
    }
}

/// Host identity plus daemon-local run identity. A setup run does not need a chat or repository.
public struct HostedSetupRun: Equatable, Sendable {
    public let host: HostRef
    public let run: SetupRun
    public init(host: HostRef, run: SetupRun) { self.host = host; self.run = run }
}
