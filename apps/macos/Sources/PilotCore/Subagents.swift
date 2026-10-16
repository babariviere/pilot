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
    /// Identity of the latest completed answer.
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

/// Configuration reported by the child's own transcript, not inherited from its parent chat.
public struct SubagentConfiguration: Equatable, Sendable {
    public private(set) var model: String?
    public private(set) var thinking: String?

    public init() {}

    public mutating func apply(_ events: [JSONValue]) {
        for event in events where event["type"]?.string == "snapshot" {
            let agent = event["agent"]
            if let provider = agent?["model"]?["provider"]?.string, !provider.isEmpty,
               let modelId = agent?["model"]?["modelId"]?.string, !modelId.isEmpty {
                model = "\(provider)/\(modelId)"
            } else {
                model = nil
            }
            thinking = agent?["thinkingLevel"]?.string.flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    public var thinkingLabel: String {
        guard let thinking else { return "Thinking not reported" }
        return "Thinking: \(thinking == "xhigh" ? "XHigh" : thinking.capitalized)"
    }
}

/// What a subagent chip or row shows, in priority order. A finished subagent is simply done: its answer goes to the
/// parent chat, which acts on it, so it never waits on the user.
public enum SubagentDisplayState: Equatable, Sendable {
    case working
    case failed
    case done

    public init(_ subagent: SessionSubagent) {
        if subagent.isWorking { self = .working }
        else if subagent.isFailed { self = .failed }
        else { self = .done }
    }

    public var label: String {
        switch self {
        case .working: "Working"
        case .failed: "Failed"
        case .done: "Done"
        }
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
