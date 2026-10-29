import Foundation

/// Mirrors packages/protocol's `AgentQuestion`: data of a `pilot.question` transcript entry written by ask_user.
/// The question is pending until a later user message, which is the reply.
public struct AgentQuestion: Equatable, Sendable {
    public struct Option: Equatable, Sendable {
        public let label: String
        public let detail: String?
        public let suggested: Bool

        public init(label: String, detail: String? = nil, suggested: Bool = false) {
            self.label = label
            self.detail = detail
            self.suggested = suggested
        }
    }

    /// Set on the db tool's access requests. The app answers them through pilotd's database-access endpoint, never
    /// with a message: the first answer allows, any other denies. A typed reply is a message, which declines.
    public struct DatabaseAccess: Equatable, Sendable {
        public let id: String
        public let env: String
        public let mode: String

        public init(id: String, env: String, mode: String) {
            self.id = id
            self.env = env
            self.mode = mode
        }
    }

    public static let entryKind = "pilot.question"
    public static let toolName = "ask_user"
    /// Number keys 1 to 9 pick answers.
    public static let maxOptions = 9

    /// The transcript entry holding the question. Stable identity for one pending question.
    public let entryID: Int
    public let question: String
    public let context: String?
    public let options: [Option]
    public let multiSelect: Bool
    public let databaseAccess: DatabaseAccess?
    /// The live run awaits this reply (`blocking: true`), so it is answered while that run works. Absent means a
    /// legacy turn-ending ask. Access requests never await a message.
    public let blocking: Bool

    public init(entryID: Int, question: String, context: String? = nil, options: [Option] = [], multiSelect: Bool = false,
                databaseAccess: DatabaseAccess? = nil, blocking: Bool = false) {
        self.entryID = entryID
        self.question = question
        self.context = context
        self.options = Array(options.prefix(Self.maxOptions))
        // Access requests are single choice: allow or deny.
        self.multiSelect = databaseAccess == nil && multiSelect && self.options.count > 1
        self.databaseAccess = databaseAccess
        self.blocking = databaseAccess == nil && blocking
    }

    init?(entryID: Int, data: JSONValue?) {
        guard let data, let question = data["question"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines),
              !question.isEmpty else { return nil }
        let options = (data["options"]?.array ?? []).compactMap { option -> Option? in
            guard let label = option["label"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty
            else { return nil }
            let detail = option["detail"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
            return Option(label: label, detail: detail?.isEmpty == false ? detail : nil,
                          suggested: option["suggested"]?.bool ?? false)
        }
        let context = data["context"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        let access = data["databaseAccess"]
        // Any access marker, even malformed, keeps the request off the awaited message path.
        let blocking = access == nil && data["blocking"]?.bool == true
        let databaseAccess = access.flatMap { access -> DatabaseAccess? in
            guard let id = access["id"]?.string, !id.isEmpty, let env = access["env"]?.string,
                  let mode = access["mode"]?.string else { return nil }
            return DatabaseAccess(id: id, env: env, mode: mode)
        }
        self.init(entryID: entryID, question: question, context: context?.isEmpty == false ? context : nil,
                  options: options, multiSelect: data["multiSelect"]?.bool ?? false, databaseAccess: databaseAccess,
                  blocking: blocking)
    }

    /// The message sent as the reply: the picked answers' labels, then any text in the user's own words.
    /// Nil when there is nothing to send.
    public func reply(selected: [Int], text: String) -> String? {
        let labels = selected.sorted().compactMap { options.indices.contains($0) ? options[$0].label : nil }
        let own = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let picked = labels.count > 1 ? labels.map { "- \($0)" }.joined(separator: "\n") : labels.first
        let parts = [picked, own.isEmpty ? nil : own].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }
}

extension Transcript {
    /// The latest question, unless a user message followed it. Automatic input counts as a reply too: the agent has
    /// moved on. Compaction summaries use the user role too, but are not replies.
    /// Scans back only to the latest actual user input.
    public var pendingQuestion: AgentQuestion? {
        for entry in entries.reversed() {
            if let question = entry.question { return question }
            if entry.kind == "pi.compaction" { continue }
            if entry.messages.contains(where: { $0.role == "user" }) { return nil }
        }
        return nil
    }
}

extension TranscriptPresentation {
    /// Wait for the agent's turn to end, not for background jobs or subagents to finish. An awaited (`blocking`)
    /// ask shows while its run works, since that run cannot continue without the reply.
    /// Check both feeds because session summaries and transcript events arrive independently.
    public func questionForComposer(session: SessionSummary, hasSnapshot: Bool) -> AgentQuestion? {
        AgentQuestion.forComposer(pendingQuestion, working: working, session: session, hasSnapshot: hasSnapshot)
    }
}

extension AgentQuestion {
    static func forComposer(_ question: AgentQuestion?, working: Bool, session: SessionSummary,
                            hasSnapshot: Bool) -> AgentQuestion? {
        guard hasSnapshot, session.state != "starting", let question else { return nil }
        if working || session.state == "working" { return question.blocking ? question : nil }
        return question
    }
}
