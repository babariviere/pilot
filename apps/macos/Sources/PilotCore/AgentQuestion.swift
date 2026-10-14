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

    public init(entryID: Int, question: String, context: String? = nil, options: [Option] = [], multiSelect: Bool = false) {
        self.entryID = entryID
        self.question = question
        self.context = context
        self.options = Array(options.prefix(Self.maxOptions))
        self.multiSelect = multiSelect && self.options.count > 1
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
        self.init(entryID: entryID, question: question, context: context?.isEmpty == false ? context : nil,
                  options: options, multiSelect: data["multiSelect"]?.bool ?? false)
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
    /// moved on. Scans back only to the latest user message.
    public var pendingQuestion: AgentQuestion? {
        for entry in entries.reversed() {
            if let question = entry.question { return question }
            if entry.messages.contains(where: { $0.role == "user" }) { return nil }
        }
        return nil
    }
}
