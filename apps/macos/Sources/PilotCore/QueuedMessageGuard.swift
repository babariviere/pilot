import Foundation

/// Opt-in queue precondition. This is not an idempotency key or permission grant.
/// Legacy Swift queue callers do not opt in automatically.
public struct QueuedMessageGuard: Codable, Equatable, Sendable {
    public let token: String
    public let operationId: String
    public let daemonId: String
    public let lineageId: String
}

/// Mirrors the guarded PATCH/DELETE success, not a current-state lookup.
public struct GuardedQueueResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let guardValue: QueuedMessageGuard
    public let sessionId: String
    public let submissionId: Int
    public let action: String

    enum CodingKeys: String, CodingKey {
        case ok, sessionId, submissionId, action
        case guardValue = "guard"
    }
}
