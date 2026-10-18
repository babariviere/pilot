import Foundation

/// How the app presents the global control chat. Its title comes from pilotd (`SessionSummary.title`), so a
/// rename only changes the daemon's one constant; these are the words around it.
public enum ControlChatIdentity {
    /// Its scope, where other chats name their project: the second line of its row and the window subtitle.
    public static let scope = "All projects"
    /// The header above its transcript: what it can see and do, in one sentence.
    public static let summary = "Sees every chat, project and mission. Starts and messages chats, keeps project memory "
        + "and acts on the events it watches. It works only through its tools and never edits files."
}

/// Mirrors the control-chat HTTP contract in packages/protocol/src/control.ts.
public enum WatchEvent: String, Codable, CaseIterable, Sendable {
    case chatSettled = "chat.settled", chatFailed = "chat.failed"
    case prMerged = "pr.merged", prClosed = "pr.closed", prReady = "pr.ready"
    case linearDone = "linear.done", missionTaskDone = "mission.task_done", missionDone = "mission.done"
}
public struct WatchTarget: Codable, Equatable, Sendable {
    /// Contract-only. Missing means the configured Control home.
    public let host: OperationHost?
    public enum Kind: String, Codable, Sendable {
        case chat, project, mission, pr, linear, task
        case chatPRs = "chat_prs"
    }
    public let kind: Kind
    public let id: String
    public let missionId: String?
}
public struct WatchFilter: Codable, Equatable, Sendable {
    public enum Outcome: String, Codable, Sendable { case done, failed, stopped }
    public let outcome: Outcome?
}
public enum WatchMode: String, Codable, Sendable { case once, persistent }
public struct WatchInput: Codable, Equatable, Sendable {
    public let authorizationId: String?
    public let event: WatchEvent
    public let target: WatchTarget
    public let filter: WatchFilter?
    public let mode: WatchMode
    public let note: String
    public let expiresAt: Double?
}
public struct Watch: Codable, Identifiable, Equatable, Sendable {
    public let authorizationId: String?
    public let id: String
    public let createdAt: Double
    public let event: WatchEvent
    public let target: WatchTarget
    public let filter: WatchFilter?
    public let mode: WatchMode
    public let note: String
    public let expiresAt: Double?
}
/// GET /api/control-chat/watches?after=<id>&limit=40. Limit 1...100; ID order.
public struct WatchesResponse: Codable, Equatable, Sendable {
    public let watches: [Watch]
    public let next: String?
}
/// DELETE /api/control-chat/watches/:id. False also covers fired/expired watches.
public struct CancelWatchResponse: Codable, Equatable, Sendable { public let removed: Bool }
public struct ControlAuditEntry: Codable, Identifiable, Equatable, Sendable {
    public let authorizationId: String?
    public enum Phase: String, Codable, Sendable { case requested, succeeded, failed }
    public var id: Int { seq }
    public let seq: Int
    public let operationId: String
    public let action: String
    public let phase: Phase
    public let at: Double
    public let caller: String
    public let args: [String: JSONValue]
    public let result: JSONValue?
}
/// GET /api/control-chat/audit?before=<seq>&limit=50. Newest first.
public typealias ControlAuditResponse = [ControlAuditEntry]
/// GET/POST /api/control-chat. POST ensures the singleton without starting a turn.
public typealias ControlChatResponse = SessionSummary

// MARK: Control memory (read-only browsing; every route 404s without a control chat)

public enum ControlMemoryKind: String, Codable, Sendable, CaseIterable {
    case user, assistant, tool, echo, event, note
}
/// One summary range: messages `id` ..< `id + n`. Pending lines have no summary yet and empty text.
public struct ControlMemoryLine: Codable, Identifiable, Hashable, Sendable {
    public var id: String { "\(start)+\(n)" }
    public let start: Int
    public let n: Int
    public let text: String
    public let pending: Bool?
    public var isPending: Bool { pending == true }
    public var end: Int { start + n - 1 }
    public init(start: Int, n: Int, text: String, pending: Bool? = nil) {
        self.start = start
        self.n = n
        self.text = text
        self.pending = pending
    }
    enum CodingKeys: String, CodingKey {
        case start = "id", n, text, pending
    }
}
/// GET /api/control-chat/memory/view. Oldest first.
public struct ControlMemoryViewResponse: Codable, Equatable, Sendable {
    public let lines: [ControlMemoryLine]
    public init(lines: [ControlMemoryLine]) { self.lines = lines }
}
/// One page of a whole message. Tool rows are JSON `{name,input,text}` with `format == "json"`.
public struct ControlMemoryMessagePage: Codable, Equatable, Sendable {
    public struct Message: Codable, Equatable, Sendable {
        public let id: Int
        public let at: Double
        public let kind: ControlMemoryKind
        public let text: String
        public let name: String?
        public init(id: Int, at: Double, kind: ControlMemoryKind, text: String, name: String? = nil) {
            self.id = id
            self.at = at
            self.kind = kind
            self.text = text
            self.name = name
        }
    }
    public let message: Message
    public let format: String?
    /// Offset of the next page of the same message.
    public let next: Int?
    public init(message: Message, format: String? = nil, next: Int? = nil) {
        self.message = message
        self.format = format
        self.next = next
    }
}
/// GET /api/control-chat/memory/nodes/:id/:n. n > 1 sets `lines` (the two halves); n = 1 sets `message`
/// (paged with `offset`).
public struct ControlMemoryNodeResponse: Codable, Equatable, Sendable {
    public let lines: [ControlMemoryLine]?
    public let message: ControlMemoryMessagePage.Message?
    public let format: String?
    public let next: Int?
    public init(lines: [ControlMemoryLine]) {
        self.lines = lines
        message = nil
        format = nil
        next = nil
    }
    public init(_ page: ControlMemoryMessagePage) {
        lines = nil
        message = page.message
        format = page.format
        next = page.next
    }
    public var page: ControlMemoryMessagePage? {
        message.map { ControlMemoryMessagePage(message: $0, format: format, next: next) }
    }
}
/// A clipped log row. `input` is the tool input as JSON text. Full content via nodes/:id/1.
public struct ControlMemoryLogEntry: Codable, Identifiable, Equatable, Sendable {
    public let id: Int
    public let at: Double
    public let kind: ControlMemoryKind
    public let text: String
    public let name: String?
    public let input: String?
    public let clipped: Bool?
    public init(id: Int, at: Double, kind: ControlMemoryKind, text: String, name: String? = nil, input: String? = nil,
                clipped: Bool? = nil) {
        self.id = id
        self.at = at
        self.kind = kind
        self.text = text
        self.name = name
        self.input = input
        self.clipped = clipped
    }
}
/// GET /api/control-chat/memory/messages?before=<id>&limit=50&q=<text>. Newest first, limit 1...100, q at most
/// 200 characters. A search scans a bounded window, so a page may hold fewer matches; continue with `next`.
public struct ControlMemoryMessagesResponse: Codable, Equatable, Sendable {
    public let messages: [ControlMemoryLogEntry]
    public let next: Int?
    public init(messages: [ControlMemoryLogEntry], next: Int? = nil) {
        self.messages = messages
        self.next = next
    }
}
/// GET /api/control-chat/memory/stats.
public struct ControlCompactionFailure: Codable, Equatable, Sendable {
    public let id: Int
    public let n: Int
    public let attempts: Int
    public let errorClass: String
    public let reason: String
    public let retryAt: Double
}
public struct ControlMemoryStats: Codable, Equatable, Sendable {
    public let count: Int
    /// Summaries waiting to be built (queued or running).
    public let pendingJobs: Int
    /// Summaries that failed; background retries use bounded exponential backoff.
    public let failedJobs: Int
    public let compactionFailure: ControlCompactionFailure?
    public let viewBytes: Int
    public let merging: Bool
    /// chat.sqlite plus its write-ahead log.
    public let dbBytes: Int
    public let oldestAt: Double?
    public let newestAt: Double?
    public init(count: Int, pendingJobs: Int, failedJobs: Int, viewBytes: Int, merging: Bool, dbBytes: Int,
                oldestAt: Double? = nil, newestAt: Double? = nil,
                compactionFailure: ControlCompactionFailure? = nil) {
        self.count = count
        self.pendingJobs = pendingJobs
        self.failedJobs = failedJobs
        self.compactionFailure = compactionFailure
        self.viewBytes = viewBytes
        self.merging = merging
        self.dbBytes = dbBytes
        self.oldestAt = oldestAt
        self.newestAt = newestAt
    }
}
/// POST /api/sessions/:id/model. Incompatible context becomes a restorable attempt with reason=model.
public typealias ChangeModelResponse = SessionSummary

public enum ControlAuthorizationLevel: String, Codable, CaseIterable, Sendable {
    case investigate, implement, publish, merge
}
public struct ControlUserMessageRef: Codable, Equatable, Sendable {
    public let conversationId: String
    public let submissionId: Int
    public let entryId: Int
    public let requestId: String
}
public struct ControlAuthorizationLimits: Codable, Equatable, Sendable {
    public let followUps: Int
    /// Optional user-set reservation limit. Missing means diagnostic-only, not a runtime cap.
    public let budgetUsd: Double?
}
public struct ControlAuthorizationUsage: Codable, Equatable, Sendable {
    public let followUps: Int
    public let budgetUsd: Double
}
public struct ControlStartBudget: Codable, Equatable, Hashable, Sendable {
    public let authorizationId: String
    /// Optional reservation, never measured spend or a runtime cap.
    public let budgetUsd: Double?
}
public struct ControlSpend: Codable, Equatable, Sendable {
    public let sessions: Int
    public let observedSessions: Int
    public let cost: AIUsageCost
    public let coverage: String
}
public struct ControlAuthorizationBudget: Codable, Equatable, Sendable {
    public let reservedUsd: Double
    public let releasedUsd: Double
}
public struct ControlAuthorization: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    /// Contract-only. Missing means home only; an empty array grants no hosts.
    public let hosts: [OperationHost]?
    public let userMessage: ControlUserMessageRef?
    public let watchId: String?
    public let scope: String
    public let level: ControlAuthorizationLevel
    public let targets: [WatchTarget]
    public let limits: ControlAuthorizationLimits
    public let createdAt: Double
    public let expiresAt: Double?
    public let revokedAt: Double?
    public let usage: ControlAuthorizationUsage
    public let budget: ControlAuthorizationBudget?
    public let spend: ControlSpend?
}
/// GET /api/control-chat/authorizations?after=<id>&limit=40. Includes expired and revoked records.
public struct ControlAuthorizationsResponse: Codable, Equatable, Sendable {
    public let authorizations: [ControlAuthorization]
    public let next: String?
}
/// DELETE /api/control-chat/authorizations/:id, local app only.
public struct RevokeControlAuthorizationResponse: Codable, Equatable, Sendable {
    public let revoked: Bool
}
