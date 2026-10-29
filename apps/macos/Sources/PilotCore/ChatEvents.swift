import Foundation

/// Mirrors packages/protocol. Older audit records may omit the structured fields and position.
public struct GitHubAction: Equatable, Sendable {
    public let id: String
    public let kind: String?
    public let branch: String?
    public let prNumber: Int?
    public let title: String?
    /// Exact URL of a PR the action created, from confirmed provenance only.
    public let url: String?
    public let toolCallId: String?
    public let afterEntryId: Int?
    public let conversationId: String?
    public let missionId: String?
    public let summary: String
    public let description: String
    public let target: String?
    public let at: Double
    public let exitCode: Int?

    public init?(json: JSONValue) {
        guard let id = json["id"]?.string else { return nil }
        self.id = id
        kind = json["kind"]?.string
        branch = json["branch"]?.string
        prNumber = json["prNumber"]?.int
        title = json["title"]?.string
        url = json["url"]?.string
        toolCallId = json["toolCallId"]?.string
        afterEntryId = json["afterEntryId"]?.int
        conversationId = json["conversationId"]?.string
        missionId = json["missionId"]?.string
        summary = json["summary"]?.string ?? ""
        description = json["description"]?.string ?? "GitHub activity"
        target = json["target"]?.string
        at = json["at"]?.number ?? 0
        exitCode = json["exitCode"]?.int
    }

    public var event: ChatEvent {
        let failed = exitCode.map { $0 != 0 } ?? false
        let pr = prNumber.map { "PR #\($0)" } ?? "a PR"
        let text: String = switch kind {
        case "push": failed ? "Agent could not push" : "Agent pushed"
        case "pr_opened": failed ? "Agent could not open \(pr)" : "Agent opened \(pr)"
        case "pr_ready": failed ? "Agent could not mark \(pr) ready" : "Agent marked \(pr) ready"
        case "pr_draft": failed ? "Agent could not mark \(pr) draft" : "Agent marked \(pr) draft"
        case "pr_edited": failed ? "Agent could not edit \(pr)" : "Agent edited \(pr)"
        case "pr_reopened": failed ? "Agent could not reopen \(pr)" : "Agent reopened \(pr)"
        case "github_updated": failed ? "Agent's GitHub update failed" : "Agent updated GitHub"
        default: failed ? "GitHub action failed" : description
        }
        return ChatEvent(id: "github-\(id)", kind: kind ?? "github_updated", text: text,
                         branch: branch, title: title, timestamp: at, destructive: failed,
                         uncertainty: exitCode == nil ? "The command's exit status is unknown." : nil,
                         detail: failed ? "Command exited with status \(exitCode!)." : nil)
    }
}

/// Mirrors the protocol's user-facing automatic event summary.
public struct ChatEventSummary: Equatable, Sendable {
    public let kind: String
    public let text: String

    public init?(json: JSONValue?) {
        guard let kind = json?["kind"]?.string, let text = json?["text"]?.string else { return nil }
        self.kind = kind
        self.text = text
    }
}

/// A quiet timeline event. Detail is user-requested disclosure, never the primary sentence.
public struct ChatEvent: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let text: String
    public var branch: String? = nil
    public var title: String? = nil
    public var timestamp: Double? = nil
    public var endTimestamp: Double? = nil
    public var destructive = false
    public var uncertainty: String? = nil
    public var detail: String? = nil
    public var count = 1

    public init(id: String, kind: String, text: String, branch: String? = nil, title: String? = nil,
                timestamp: Double? = nil, destructive: Bool = false, uncertainty: String? = nil,
                detail: String? = nil) {
        self.id = id; self.kind = kind; self.text = text; self.branch = branch; self.title = title
        self.timestamp = timestamp; self.destructive = destructive; self.uncertainty = uncertainty; self.detail = detail
    }

    public var sentence: String {
        if count == 1 { return text }
        if kind == "push", !destructive { return "Agent pushed \(count) times to" }
        return "\(text) · \(count) times"
    }

    func canCollapse(with other: ChatEvent) -> Bool {
        if kind == "push", other.kind == "push", let branch, branch == other.branch,
           !destructive, !other.destructive { return true }
        return kind == other.kind && text == other.text && branch == other.branch && title == other.title
            && destructive == other.destructive && uncertainty == other.uncertainty && detail == other.detail
    }
}
