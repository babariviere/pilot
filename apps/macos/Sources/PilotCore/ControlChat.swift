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
    public let event: WatchEvent
    public let target: WatchTarget
    public let filter: WatchFilter?
    public let mode: WatchMode
    public let note: String
    public let expiresAt: Double?
}
public struct Watch: Codable, Identifiable, Equatable, Sendable {
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
/// POST /api/sessions/:id/model. Incompatible context becomes a restorable attempt with reason=model.
public typealias ChangeModelResponse = SessionSummary
