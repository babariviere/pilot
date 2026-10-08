import Foundation

/// Mirrors packages/protocol `SessionSubagent`. Keep both sides in sync.
public struct SessionSubagent: Codable, Identifiable, Equatable, Hashable, Sendable {
    public enum State: String, Codable, Hashable, Sendable {
        case working
        case idle
    }

    public let name: String
    public let state: State
    /// The spawn message.
    public let task: String
    /// Epoch milliseconds.
    public let createdAt: Double
    public let cwd: String
    public let model: String?
    /// Identity of the latest completed answer. A change means a new answer.
    public let lastAnswerId: String?
    public let error: String?
    public let retired: Bool?

    public var id: String { name }
    public var isWorking: Bool { state == .working }
    public var isFailed: Bool { !isWorking && error != nil }
    public var acceptsMessages: Bool { retired != true }

    public init(
        name: String, state: State, task: String, createdAt: Double, cwd: String, model: String? = nil,
        lastAnswerId: String? = nil, error: String? = nil, retired: Bool? = nil
    ) {
        self.name = name
        self.state = state
        self.task = task
        self.createdAt = createdAt
        self.cwd = cwd
        self.model = model
        self.lastAnswerId = lastAnswerId
        self.error = error
        self.retired = retired
    }
}

/// What a subagent chip or row shows, in priority order.
public enum SubagentDisplayState: Equatable, Sendable {
    case working
    case newAnswer
    case failed
    case idle

    public init(_ subagent: SessionSubagent, unread: Bool) {
        if subagent.isWorking { self = .working }
        else if subagent.isFailed { self = .failed }
        else if unread { self = .newAnswer }
        else { self = .idle }
    }

    public var label: String {
        switch self {
        case .working: "Working"
        case .newAnswer: "New answer"
        case .failed: "Failed"
        case .idle: "Idle"
        }
    }
}

/// Answers the user has opened, per session and subagent. A different answer ID is unread again.
public struct SubagentReadState: Codable, Equatable, Sendable {
    private var seen: [String: [String: String]] = [:]

    public init() {}

    public func isUnread(_ subagent: SessionSubagent, in sessionId: String) -> Bool {
        guard let answer = subagent.lastAnswerId else { return false }
        return seen[sessionId]?[subagent.name] != answer
    }

    public func unreadCount(_ subagents: [SessionSubagent], in sessionId: String) -> Int {
        subagents.filter { isUnread($0, in: sessionId) && !$0.isWorking }.count
    }

    /// Returns whether anything changed.
    @discardableResult
    public mutating func markRead(_ subagent: SessionSubagent, in sessionId: String) -> Bool {
        guard let answer = subagent.lastAnswerId, seen[sessionId]?[subagent.name] != answer else { return false }
        seen[sessionId, default: [:]][subagent.name] = answer
        return true
    }

    /// Forget sessions that no longer exist.
    public mutating func retain(sessions: Set<String>) {
        seen = seen.filter { sessions.contains($0.key) }
    }
}

/// A subagent answer or failure delivered to the parent as a follow-up message by the subagents extension.
public struct SubagentNotification: Equatable, Sendable {
    public let name: String
    public let failed: Bool
    public let text: String

    /// Parses `[subagent "name" answered, no reply needed] text` (or `failed`), as sent by pi-extensions.
    public init?(message: String) {
        let prefix = "[subagent "
        guard message.hasPrefix(prefix) else { return nil }
        var rest = message.dropFirst(prefix.count)
        // The name is a JSON string literal.
        guard rest.first == "\"" else { return nil }
        var index = rest.index(after: rest.startIndex)
        var escaped = false
        while index < rest.endIndex {
            let character = rest[index]
            if escaped { escaped = false }
            else if character == "\\" { escaped = true }
            else if character == "\"" { break }
            index = rest.index(after: index)
        }
        guard index < rest.endIndex,
              let data = String(rest[rest.startIndex ... index]).data(using: .utf8),
              let name = try? JSONDecoder().decode(String.self, from: data)
        else { return nil }
        rest = rest[rest.index(after: index)...]
        let failed: Bool
        if rest.hasPrefix(" answered") { failed = false }
        else if rest.hasPrefix(" failed") { failed = true }
        else { return nil }
        guard let close = rest.firstIndex(of: "]") else { return nil }
        self.name = name
        self.failed = failed
        text = rest[rest.index(after: close)...].trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// One subagent of one session, as a stream subscription key.
public struct SubagentKey: Hashable, Sendable {
    public let sessionId: String
    public let name: String

    public init(sessionId: String, name: String) {
        self.sessionId = sessionId
        self.name = name
    }
}

public struct SubagentMessageRequest: Encodable, Sendable {
    public let message: String
    public let mode: DeliveryMode
    public let requestId: String

    public init(message: String, mode: DeliveryMode, requestId: String = UUID().uuidString) {
        self.message = message
        self.mode = mode
        self.requestId = requestId
    }
}

public extension Transcript {
    /// A transcript built from a one-shot snapshot, for read-only views.
    init(events: [JSONValue]) {
        self.init()
        apply(events)
    }
}
