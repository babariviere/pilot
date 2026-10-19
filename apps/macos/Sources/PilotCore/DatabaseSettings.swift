import Foundation

public struct DatabaseConnectionSettings: Codable, Equatable, Sendable {
    public var scheme: String
    public var host: String
    public var port: String
    public var database: String
    public var user: String
    public var hasCredentials: Bool
    public var access: String

    public var summary: String {
        let server = host + (port.isEmpty ? "" : ":\(port)")
        return "\(user.isEmpty ? "" : user + "@")\(server)/\(database)"
    }
}

public struct DatabaseEnvironmentSettings: Codable, Equatable, Sendable {
    public var name: String
    public var read: DatabaseConnectionSettings?
    public var write: DatabaseConnectionSettings?
}

public struct ProjectDatabaseSettings: Codable, Equatable, Sendable {
    public var revision: String
    public var environments: [DatabaseEnvironmentSettings]
}

public struct DatabaseConnectionUpdate: Codable, Equatable, Sendable {
    public var url: String?
    public var access: String?
}

public struct DatabaseEnvironmentUpdate: Codable, Equatable, Sendable {
    public var name: String
    public var read: DatabaseConnectionUpdate?
    public var write: DatabaseConnectionUpdate?
}

public struct ProjectDatabaseSettingsUpdate: Codable, Equatable, Sendable {
    public var revision: String
    public var environments: [DatabaseEnvironmentUpdate]

    public init(revision: String, environments: [DatabaseEnvironmentUpdate]) {
        self.revision = revision
        self.environments = environments
    }
}

/// Secrets exist only in a pending replacement, never in the loaded snapshot or a display summary.
public struct DatabaseConnectionDraft: Equatable, Sendable {
    public var enabled: Bool
    public var replacementURL = ""
    public var access: String
    public let stored: DatabaseConnectionSettings?

    public init(stored: DatabaseConnectionSettings? = nil) {
        self.stored = stored
        enabled = stored != nil
        access = stored?.access ?? "ask"
    }

    public var update: DatabaseConnectionUpdate? {
        guard enabled else { return nil }
        return .init(url: replacementURL.isEmpty ? nil : replacementURL,
                     access: access == (stored?.access ?? "ask") ? nil : access)
    }
}

public struct DatabaseEnvironmentDraft: Equatable, Identifiable, Sendable {
    public let id = UUID()
    public var name: String
    public var read: DatabaseConnectionDraft
    public var write: DatabaseConnectionDraft

    public init(stored: DatabaseEnvironmentSettings? = nil) {
        name = stored?.name ?? ""
        read = .init(stored: stored?.read)
        write = .init(stored: stored?.write)
        if stored == nil { read.enabled = true }
    }

    public var update: DatabaseEnvironmentUpdate {
        .init(name: name, read: read.update, write: write.update)
    }

    public var validationError: String? {
        guard name.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$", options: .regularExpression) != nil else {
            return "Use a 1–64 character environment name starting with a letter or digit."
        }
        guard read.enabled || write.enabled else { return "Enable a read or write connection." }
        for connection in [read, write] where connection.enabled {
            if connection.replacementURL.isEmpty {
                guard connection.stored != nil else { return "Enter a Postgres URL for each new connection." }
            } else if !connection.replacementURL.hasPrefix("postgres://") && !connection.replacementURL.hasPrefix("postgresql://") {
                return "Connection URLs must start with postgres:// or postgresql://."
            }
        }
        return nil
    }
}
