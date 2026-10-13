import Foundation

/// One-shot triggers. onBack means the next wake followed by network reachability.
public enum ScheduleTrigger: String, Codable, Sendable {
    case at
    case onWake = "on_wake"
    case onOnline = "on_online"
    case onBack = "on_back"
}
public enum ScheduleState: String, Codable, Sendable {
    case pending, dispatching, fired, failed, cancelled
}

/// Mirrors the discriminated target in packages/protocol/src/schedules.ts.
public enum ScheduleTarget: Codable, Sendable {
    case chat(SpawnRequest)
    case message(sessionId: String, message: String)

    private enum Keys: String, CodingKey { case kind, spawn, sessionId, message }
    private enum Kind: String, Codable { case chat, message }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(Kind.self, forKey: .kind) {
        case .chat: self = .chat(try c.decode(SpawnRequest.self, forKey: .spawn))
        case .message: self = .message(
            sessionId: try c.decode(String.self, forKey: .sessionId),
            message: try c.decode(String.self, forKey: .message)
        )
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .chat(spawn):
            try c.encode(Kind.chat, forKey: .kind)
            try c.encode(spawn, forKey: .spawn)
        case let .message(sessionId, message):
            try c.encode(Kind.message, forKey: .kind)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(message, forKey: .message)
        }
    }
}

/// POST /api/schedules. Omitted trigger defaults to onBack.
public struct ScheduleRequest: Codable, Sendable {
    public var title: String?
    public var trigger: ScheduleTrigger?
    public var at: Double?
    public var target: ScheduleTarget

    public init(title: String? = nil, trigger: ScheduleTrigger? = nil, at: Double? = nil, target: ScheduleTarget) {
        self.title = title
        self.trigger = trigger
        self.at = at
        self.target = target
    }
}

/// PATCH /api/schedules/:id. Only pending items can be edited.
public struct SchedulePatch: Codable, Sendable {
    public var title: String?
    public var trigger: ScheduleTrigger?
    public var at: Double?
    public var target: ScheduleTarget?
    public var expectedRevision: Int?

    public init(
        title: String? = nil, trigger: ScheduleTrigger? = nil, at: Double? = nil,
        target: ScheduleTarget? = nil, expectedRevision: Int? = nil
    ) {
        self.title = title
        self.trigger = trigger
        self.at = at
        self.target = target
        self.expectedRevision = expectedRevision
    }
}

/// GET /api/schedules[?projectId=…], GET /api/schedules/:id, and WS schedules.
/// Epoch times use milliseconds. Interrupted claims surface as failures, never automatic retries.
public struct ScheduledItem: Codable, Identifiable, Sendable {
    public let id: String
    public let revision: Int
    public let title: String
    public let projectId: String?
    public let trigger: ScheduleTrigger
    public let at: Double?
    public let target: ScheduleTarget
    public let state: ScheduleState
    public let createdAt: Double
    public let updatedAt: Double
    public let wakeObserved: Bool?
    public let claimedAt: Double?
    public let firedAt: Double?
    public let sessionId: String?
    public let error: String?

    public init(
        id: String, revision: Int, title: String, projectId: String? = nil,
        trigger: ScheduleTrigger, at: Double? = nil, target: ScheduleTarget,
        state: ScheduleState, createdAt: Double, updatedAt: Double,
        wakeObserved: Bool? = nil, claimedAt: Double? = nil, firedAt: Double? = nil,
        sessionId: String? = nil, error: String? = nil
    ) {
        self.id = id
        self.revision = revision
        self.title = title
        self.projectId = projectId
        self.trigger = trigger
        self.at = at
        self.target = target
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.wakeObserved = wakeObserved
        self.claimedAt = claimedAt
        self.firedAt = firedAt
        self.sessionId = sessionId
        self.error = error
    }
}
