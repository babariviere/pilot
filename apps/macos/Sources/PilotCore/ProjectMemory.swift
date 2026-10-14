import Foundation

// Mirrors packages/protocol/src/memory.ts. All ranges have inclusive ends.
public struct MemoryRange: Codable, Equatable, Sendable {
    public let lo: Int
    public let hi: Int
    public init(lo: Int, hi: Int) { self.lo = lo; self.hi = hi }
}

public struct MemoryEntry: Codable, Equatable, Sendable, Identifiable {
    public let index: Int
    public let id: String
    public let deviceId: String
    public let at: Double
    public let sessionId: String
    public let text: String
    /// Stable ids of earlier notes this one corrects.
    public let replaces: [String]?
    /// Derived by the daemon on read: index of the latest note that corrects this one.
    public let replacedBy: Int?
    public init(index: Int, id: String, deviceId: String, at: Double, sessionId: String, text: String,
                replaces: [String]? = nil, replacedBy: Int? = nil) {
        self.index = index; self.id = id; self.deviceId = deviceId
        self.at = at; self.sessionId = sessionId; self.text = text
        self.replaces = replaces; self.replacedBy = replacedBy
    }
}

public struct MemoryNode: Codable, Equatable, Sendable {
    public let lo: Int
    public let hi: Int
    public let text: String?
    public let entry: MemoryEntry?
    public let pending: Bool?
    /// A replaced note, or a summary whose notes were all replaced. Wake hides these; zoom still returns them.
    public let replaced: Bool?
    public init(lo: Int, hi: Int, text: String? = nil, entry: MemoryEntry? = nil, pending: Bool? = nil,
                replaced: Bool? = nil) {
        self.lo = lo; self.hi = hi; self.text = text; self.entry = entry; self.pending = pending
        self.replaced = replaced
    }
}

public struct MemoryView: Codable, Equatable, Sendable {
    public let count: Int
    public let nodes: [MemoryNode]
    public let omittedBefore: Int
    public let text: String
    public init(count: Int, nodes: [MemoryNode], omittedBefore: Int, text: String) {
        self.count = count; self.nodes = nodes; self.omittedBefore = omittedBefore; self.text = text
    }
}

public struct MemoryRecall: Codable, Equatable, Sendable {
    public let count: Int
    public let matches: Int
    public let entries: [MemoryEntry]
    public let truncated: Bool
    public init(count: Int, matches: Int, entries: [MemoryEntry], truncated: Bool) {
        self.count = count; self.matches = matches; self.entries = entries; self.truncated = truncated
    }
}

public struct MemoryCompaction: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case idle, pending, running, backoff }
    public let state: State
    public let pending: Int
    public let error: String?
    public let retryAt: Double?
    public init(state: State = .idle, pending: Int = 0, error: String? = nil, retryAt: Double? = nil) {
        self.state = state; self.pending = pending; self.error = error; self.retryAt = retryAt
    }
}

public struct ProjectMemorySummary: Codable, Equatable, Sendable {
    public let count: Int
    /// Newest first, at most five entries.
    public let recent: [MemoryEntry]
    public let compaction: MemoryCompaction
    public init(count: Int = 0, recent: [MemoryEntry] = [], compaction: MemoryCompaction = .init()) {
        self.count = count; self.recent = recent; self.compaction = compaction
    }
}

public struct MemoryNoteRequest: Codable, Equatable, Sendable {
    public let text: String
    public let sessionId: String
    /// Indices of notes this one corrects.
    public let replaces: [Int]?
    public init(text: String, sessionId: String, replaces: [Int]? = nil) {
        self.text = text; self.sessionId = sessionId; self.replaces = replaces
    }
}
