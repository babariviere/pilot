import Foundation

/// Mirrors packages/protocol's read-only SessionTodo projection.
public struct SessionTodo: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let status: String
    public let createdAt: String
    public let assignedToSession: String?

    public var isClosed: Bool { ["closed", "done"].contains(status.lowercased()) }

    public func isWorking(in sessionId: String) -> Bool {
        !isClosed && assignedToSession == sessionId
    }

    public init?(json: JSONValue) {
        guard let id = json["id"]?.string, !id.isEmpty,
              let title = json["title"]?.string,
              let status = json["status"]?.string else { return nil }
        self.id = id
        self.title = title
        self.status = status
        createdAt = json["createdAt"]?.string ?? ""
        assignedToSession = json["assignedToSession"]?.string
    }
}

public extension Collection where Element == SessionTodo {
    func inDisplayOrder(for sessionId: String) -> [SessionTodo] {
        sorted { a, b in
            if a.isWorking(in: sessionId) != b.isWorking(in: sessionId) { return a.isWorking(in: sessionId) }
            if a.isClosed != b.isClosed { return !a.isClosed }
            if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
            return a.id < b.id
        }
    }
}
