import Foundation

public struct DiagnosticEvidenceSubject: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case app, chat }
    public let kind: Kind
    public let host: HostRef
    public let sessionId: String?
    public let chatUrl: String?

    public static func app(host: HostRef) -> Self {
        Self(kind: .app, host: host, sessionId: nil, chatUrl: nil)
    }
    public static func chat(_ target: DiagnosticTargetReference) -> Self {
        Self(kind: .chat, host: target.host, sessionId: target.sessionId, chatUrl: target.chatURL)
    }
    public var target: DiagnosticTargetReference? {
        guard kind == .chat, let sessionId else { return nil }
        return DiagnosticTargetReference(host: host, sessionId: sessionId)
    }
}

public struct DiagnosticRepairProjectBinding: Codable, Equatable, Sendable {
    public static let requiredOrigin = #"["github.com","babariviere/pilot"]"#
    public let schemaVersion: Int
    public let id: String
    public let revision: Int
    public let host: HostRef
    public let projectId: String
    public let path: String
    public let origin: String
    public let configuredAt: String

    public init(schemaVersion: Int = 1, id: String, revision: Int, host: HostRef,
                projectId: String, path: String, origin: String = DiagnosticRepairProjectBinding.requiredOrigin, configuredAt: String) {
        self.schemaVersion = schemaVersion; self.id = id; self.revision = revision; self.host = host
        self.projectId = projectId; self.path = path; self.origin = origin; self.configuredAt = configuredAt
    }

    public func matches(host: HostRef, projects: [Project]) -> Bool {
        schemaVersion == 1 && UUID(uuidString: id) != nil && revision > 0 && self.host == host &&
            origin == Self.requiredOrigin && projects.contains { $0.id == projectId && $0.path == path }
    }
}

public struct DiagnosticRepairProjectStatus: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case missing, available, unavailable, invalid }
    public let state: State
    public let revision: Int
    public let binding: DiagnosticRepairProjectBinding?
    public let reason: String?

    public init(state: State, revision: Int, binding: DiagnosticRepairProjectBinding? = nil, reason: String? = nil) {
        self.state = state; self.revision = revision; self.binding = binding; self.reason = reason
    }
}

public struct DiagnosticRepairProjectSetup: Codable, Sendable {
    public let expectedRevision: Int
    public let host: HostRef
    public let projectId: String
    public let path: String
    public let origin: String

    public init(expectedRevision: Int, host: HostRef, projectId: String, path: String, origin: String) {
        self.expectedRevision = expectedRevision; self.host = host; self.projectId = projectId
        self.path = path; self.origin = origin
    }
}

/// Content-free, bounded native review data. No synthetic session is needed for an app subject.
public struct AppDiagnosticEvidence: Codable, Sendable {
    public let schemaVersion: Int
    public let host: HostRef
    public let collectedAt: String
    public let evidence: [DiagnosticEvidence]
}

public struct DiagnosticHostHealth: Codable, Sendable {
    public let totalSessions: Int
    public let activeSessions: Int
    public let workingSessions: Int
    public let failedSessions: Int
    public let archivedSessions: Int
    public let rssBytes: Double?
    public let heapUsedBytes: Double?
}
