import Foundation

/// Positive setup subset, never credentials or expanded config. Mirrors protocol/mcp-setup.ts.
public struct McpShareConfig: Codable, Equatable, Sendable {
    public var type: String?
    public var url: String?
    public var command: String?
    public var args: [String]?
    public var env: [String: String]?
    public var headers: [String: String]?
    public var enabled: Bool?
    public var exposure: String?
    public var timeout: Double?
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case type, url, command, args, env, headers, enabled, exposure, timeout
    }
    private struct Field: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: Field.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        guard fields.allKeys.allSatisfy({ allowed.contains($0.stringValue) }),
              try fields.allKeys.allSatisfy({ try !fields.decodeNil(forKey: $0) }) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unsupported MCP setup fields"))
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decodeIfPresent(String.self, forKey: .type)
        url = try values.decodeIfPresent(String.self, forKey: .url)
        command = try values.decodeIfPresent(String.self, forKey: .command)
        args = try values.decodeIfPresent([String].self, forKey: .args)
        env = try values.decodeIfPresent([String: String].self, forKey: .env)
        headers = try values.decodeIfPresent([String: String].self, forKey: .headers)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled)
        exposure = try values.decodeIfPresent(String.self, forKey: .exposure)
        timeout = try values.decodeIfPresent(Double.self, forKey: .timeout)
    }
    public init(type: String? = nil, url: String? = nil, command: String? = nil, args: [String]? = nil,
                env: [String: String]? = nil, headers: [String: String]? = nil, enabled: Bool? = nil,
                exposure: String? = nil, timeout: Double? = nil) {
        self.type = type; self.url = url; self.command = command; self.args = args; self.env = env
        self.headers = headers; self.enabled = enabled; self.exposure = exposure; self.timeout = timeout
    }

    public var shareable: Bool {
        guard args?.isEmpty != false, env?.isEmpty != false, headers?.isEmpty != false,
              exposure.map({ ["codemode", "codemode-deferred", "deferred", "direct", "hidden"].contains($0) }) != false,
              timeout.map({ $0.isFinite && $0 > 0 && $0 <= 600 }) != false else { return false }
        if let url, command == nil {
            guard type == nil || type == "http" || type == "streamable-http",
                  url.utf8.count <= 2048, url.range(of: #"[\s\\@?#$!]"#, options: .regularExpression) == nil,
                  url.range(of: #"[^\x21-\x7e]"#, options: .regularExpression) == nil,
                  let value = URLComponents(string: url), value.scheme?.lowercased() == "https", value.user == nil,
                  value.password == nil, value.query == nil, value.fragment == nil, value.port == nil || value.port == 443,
                  let hostname = value.host?.lowercased() else { return false }
            let host = hostname.hasSuffix(".") ? String(hostname.dropLast()) : hostname
            guard host.contains("."),
                  host.range(of: #"^[a-z0-9.-]+$"#, options: .regularExpression) != nil,
                  host.range(of: #"(?:^|\.)(?:localhost|local|internal)$"#, options: .regularExpression) == nil,
                  host.range(of: #"^[0-9.]+$"#, options: .regularExpression) == nil,
                  ["", "/", "/mcp", "/mcp/", "/api/mcp", "/v1/mcp"].contains(value.path) else { return false }
            return true
        }
        guard let command, url == nil, type == nil || type == "stdio" else { return false }
        return command.range(of: #"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$"#, options: .regularExpression) != nil
    }
}

public struct McpSetupEntry: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let config: McpShareConfig?
    public let blocked: String?
    public let dependencyAvailable: Bool?
    public var id: String { name }
    public init(name: String, config: McpShareConfig? = nil, blocked: String? = nil, dependencyAvailable: Bool? = nil) {
        self.name = name; self.config = config; self.blocked = blocked; self.dependencyAvailable = dependencyAvailable
    }
}

public struct McpSetupSnapshot: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let writeMode: String
    public let revision: String
    public let exists: Bool
    public let entries: [McpSetupEntry]
    public let invalidNames: Int
    public init(schemaVersion: Int = 1, writeMode: String = "additive", revision: String, exists: Bool, entries: [McpSetupEntry], invalidNames: Int = 0) {
        self.schemaVersion = schemaVersion
        self.writeMode = writeMode
        self.revision = revision; self.exists = exists; self.entries = entries; self.invalidNames = invalidNames
    }
}

public struct McpSetupApplyRequest: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let name: String
        public let config: McpShareConfig
        public init(name: String, config: McpShareConfig) { self.name = name; self.config = config }
    }
    public let expectedRevision: String
    public let entries: [Entry]
    public init(expectedRevision: String, entries: [Entry]) { self.expectedRevision = expectedRevision; self.entries = entries }
}
