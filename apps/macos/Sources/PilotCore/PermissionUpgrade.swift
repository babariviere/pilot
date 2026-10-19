import Foundation

/// Mirrors the daemon's pending request. Messages never approve this request.
public struct PermissionUpgradeRequest: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let chatId: String
    public let chatTitle: String
    public let level: String
    public let scope: String
    public let requestedBy: String
    public let createdAt: Double
    public let expiresAt: Double

    public init(id: String, chatId: String, chatTitle: String, level: String = "publish", scope: String,
                requestedBy: String, createdAt: Double, expiresAt: Double) {
        self.id = id
        self.chatId = chatId
        self.chatTitle = chatTitle
        self.level = level
        self.scope = scope
        self.requestedBy = requestedBy
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

public struct PermissionUpgradeDecision: Encodable, Sendable {
    public let id: String
    public let allow: Bool
    public init(id: String, allow: Bool) { self.id = id; self.allow = allow }
}
