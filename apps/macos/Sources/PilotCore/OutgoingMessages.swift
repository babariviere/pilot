import Foundation

/// Messages the user just sent from an idle chat, shown in the transcript at once while pilotd starts the run.
///
/// pilotd acknowledges a send before the agent commits it, and the committed user message can take a moment
/// longer (a parked worker restarts, extensions prepare the turn). Each message here stands in for one committed
/// user row and goes away, in the same update, when a new user row arrives. A submission that briefly sits in the
/// queue on its way into the run is the same message in transit, so the queue strip hides it meanwhile.
public struct OutgoingMessages: Equatable, Sendable {
    public struct Message: Identifiable, Equatable, Sendable {
        public let id: UUID
        public let text: String
        /// When pilotd accepted the send, or nil while the request is still in flight.
        public fileprivate(set) var acceptedAt: Date?
        fileprivate var queueID: Int?
    }

    /// An accepted message the transcript never confirms (for example a run that failed to start) stops standing
    /// in after this long.
    public static let confirmationTimeout: TimeInterval = 60
    /// Rows at the end of the transcript checked for new user messages. A user row lands at the end, and only a
    /// few batches arrive before it, so this bounds the work while any message waits.
    static let recentRows = 128

    public private(set) var messages: [Message] = []
    private var knownUserRows: Set<String> = []
    private var knownQueue: Set<Int> = []

    public init() {}

    public var isEmpty: Bool { messages.isEmpty }

    /// Queued submissions that are these messages on their way into the run.
    public var hiddenQueueIDs: Set<Int> { Set(messages.compactMap(\.queueID)) }

    /// The earliest time a message expires, so the owner can schedule one check instead of polling.
    public var nextDeadline: Date? {
        messages.compactMap { $0.acceptedAt?.addingTimeInterval(Self.confirmationTimeout) }.min()
    }

    @discardableResult
    public mutating func add(_ text: String, to presentation: TranscriptPresentation) -> UUID {
        if messages.isEmpty {
            // Everything already shown is history, not a reply to this send.
            knownUserRows = Set(Self.recentUserRows(presentation).map(\.id))
            knownQueue = Set(presentation.queuedMessages.map(\.id))
        }
        let id = UUID()
        messages.append(Message(id: id, text: text))
        return id
    }

    /// pilotd rejected the send, and the composer has the draft back.
    public mutating func remove(_ id: UUID) {
        messages.removeAll { $0.id == id }
    }

    public mutating func accept(_ id: UUID, at now: Date = Date()) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].acceptedAt = now
    }

    public mutating func removeAll() {
        messages = []
    }

    /// Matches new user rows and queued submissions to waiting messages. Returns whether anything changed.
    @discardableResult
    public mutating func reconcile(with presentation: TranscriptPresentation, now: Date = Date()) -> Bool {
        guard !messages.isEmpty else { return false }
        let before = messages
        for row in Self.recentUserRows(presentation) where !knownUserRows.contains(row.id) {
            knownUserRows.insert(row.id)
            guard !messages.isEmpty else { continue }
            // Prefer the same text; otherwise the oldest, since prompt templates and skills arrive expanded.
            let index = messages.firstIndex { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == row.text } ?? 0
            messages.remove(at: index)
        }
        for message in presentation.queuedMessages where !knownQueue.contains(message.id) {
            knownQueue.insert(message.id)
            if let index = messages.firstIndex(where: { $0.queueID == nil }) { messages[index].queueID = message.id }
        }
        messages.removeAll { message in
            message.acceptedAt.map { now.timeIntervalSince($0) >= Self.confirmationTimeout } ?? false
        }
        if messages.isEmpty {
            knownUserRows = []
            knownQueue = []
        }
        return messages != before
    }

    static func recentUserRows(_ presentation: TranscriptPresentation) -> [(id: String, text: String)] {
        let live = presentation.liveRows
        let history = presentation.historyRows.suffix(max(0, recentRows - live.count))
        return (history + live).compactMap { row in
            // Subagent answers arrive as user messages but are not the user's.
            guard case let .user(id, text, _) = row, SubagentNotification(message: text) == nil else { return nil }
            return (id, text.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
}
