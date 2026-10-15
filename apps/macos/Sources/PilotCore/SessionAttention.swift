import Foundation

public enum SessionOutcome: String, Codable, Sendable {
    case done
    case failed
    case stopped
    /// The run ended on an ask_user question. The chat waits for the user's reply.
    case question

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        // Older daemons persisted questions as a separate outcome. They are completed turns now.
        if value == "needs_input" {
            self = .done
        } else if let outcome = Self(rawValue: value) {
            self = outcome
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unknown session outcome: \(value)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum SessionStatus: String, Sendable {
    case working = "Working"
    /// The agent asked a question and waits for the user's answer.
    case question = "Needs you"
    case done = "Done"
    case failed = "Failed"
    case stopped = "Stopped"
    case idle = "Idle"
    case paused = "Paused until wake"
    /// Work is held at a subscription usage limit until it resets.
    case usagePaused = "Paused at usage limit"
}

extension SessionSummary {
    /// Outcomes survive lifecycle changes. A completed turn does not finish active coordination.
    public var status: SessionStatus {
        if sleepPaused == true { return .paused }
        if isHeldAtUsageLimit { return .usagePaused }
        if isWorking { return .working }
        switch outcome {
        case .done: return isActiveMissionCoordinator ? .idle : .done
        case .question: return .question
        case .failed: return .failed
        case .stopped: return .stopped
        case nil: return state == "failed" ? .failed : .idle
        }
    }

    public var visibleOutcomeAt: Double? {
        guard sleepPaused != true, !isHeldAtUsageLimit, !isWorking, outcome != nil, let outcomeAt, outcomeAt.isFinite
        else { return nil }
        return outcomeAt
    }
}

public struct SessionOutcomeNotification: Equatable, Sendable {
    public let sessionId: String
    public let outcomeAt: Double
    public let title: String
    public let body: String
    public var identifier: String { "\(sessionId)-outcome-\(outcomeAt)" }
}

/// Persistent review and notification high-water marks, independent of UI and transport.
/// Call on the client's serial executor. Reviewing never changes the session's outcome.
///
/// Reading a result marks it reviewed at once (and pilotd stops counting it), but the open chat keeps its sidebar
/// group until the user leaves it, so the row never jumps away under the pointer. That hold lives in memory only:
/// leaving the chat, closing the window or quitting releases it.
public final class SessionAttention {
    private let defaults: UserDefaults
    private let reviewedKey = "pilot.reviewedOutcomeAt"
    private let observedKey = "pilot.observedOutcomeAt"
    /// Earlier builds persisted viewed results here to keep them under Needs you. Removed on launch.
    private static let legacyAwaitingReplyKey = "pilot.awaitingReplyOutcomeAt"
    private var reviewed: [String: Double]
    private var observed: [String: Double]
    /// Results read while their chat was open, by outcome version. Released when the user leaves the chat.
    private var held: [String: Double] = [:]
    private var receivedSnapshot = false

    /// Fired only when a review high-water mark advances.
    public var onReview: ((ReviewRequest.Mark) -> Void)?

    /// One bounded launch backfill. Prefer recent reviews, with stable ordering for equal versions.
    @MainActor public func reviewMarks() async -> [ReviewRequest.Mark] {
        // Snapshot on the client's executor; selection from a large history must not block the UI.
        let marks = reviewed
        return await Task.detached(priority: .utility) {
            marks.filter { $0.value.isFinite }
                .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
                .prefix(ReviewRequest.maxMarks)
                .map { ReviewRequest.Mark(sessionId: $0.key, outcomeAt: $0.value) }
        }.value
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        reviewed = defaults.dictionary(forKey: reviewedKey) as? [String: Double] ?? [:]
        observed = defaults.dictionary(forKey: observedKey) as? [String: Double] ?? [:]
        defaults.removeObject(forKey: Self.legacyAwaitingReplyKey)
    }

    public func isUnread(_ session: SessionSummary) -> Bool {
        // A question waits on the user even when the chat's PRs have settled.
        guard session.outcome == .question || !session.hasTerminalPullRequest else { return false }
        guard let version = session.visibleOutcomeAt else { return false }
        return reviewed[session.id].map { $0 < version } ?? true
    }

    /// Read while its chat is open, so the row keeps its group until the user leaves the chat. A reply or a newer
    /// result (another outcome version), archiving or settled PRs end the hold on their own.
    public func isHeld(_ session: SessionSummary) -> Bool {
        guard !session.isArchived, !session.hasTerminalPullRequest, let version = session.visibleOutcomeAt else {
            return false
        }
        return held[session.id] == version
    }

    /// The user left every chat except `openSessionId` (nil when no chat is open): their read results regroup.
    /// Returns whether anything changed.
    @discardableResult
    public func leave(keeping openSessionId: String?) -> Bool {
        guard held.keys.contains(where: { $0 != openSessionId }) else { return false }
        held = held.filter { $0.key == openSessionId }
        return true
    }

    /// Marks a result read when its chat is visible in the active app, and holds its group until the user leaves.
    @discardableResult
    public func review(_ session: SessionSummary, chatVisible: Bool, appActive: Bool) -> Bool {
        guard chatVisible && appActive, isUnread(session), let version = session.visibleOutcomeAt else { return false }
        reviewed[session.id] = version
        defaults.set(reviewed, forKey: reviewedKey)
        held[session.id] = version
        onReview?(ReviewRequest.Mark(sessionId: session.id, outcomeAt: version))
        return true
    }

    /// The first snapshot establishes a quiet baseline (historical results remain unread).
    /// Later snapshots catch completions missed while disconnected. Stable outcomeAt, not
    /// lifecycle or updatedAt, deduplicates broadcasts, parking, and reconnects.
    public func observe(_ sessions: [SessionSummary], snapshot: Bool) -> [SessionOutcomeNotification] {
        let baseline = snapshot && !receivedSnapshot
        if snapshot { receivedSnapshot = true }
        var notifications: [SessionOutcomeNotification] = []
        for session in sessions {
            guard session.outcome != nil, let version = session.outcomeAt, version.isFinite else { continue }
            if !baseline && session.isWorking && !session.hasTerminalPullRequest { continue }
            guard observed[session.id].map({ $0 < version }) ?? true else { continue }
            observed[session.id] = version
            guard !baseline, isUnread(session) else { continue }
            let title: String
            switch session.outcome {
            case .done: title = session.isActiveMissionCoordinator ? "New result" : "Session done"
            case .question: title = "Question"
            case .failed: title = "Session failed"
            case .stopped: title = "Session stopped"
            case nil: continue
            }
            let reason = session.outcomeReason ?? (session.outcome == .failed ? session.error : nil)
            let body = reason.map { "\(session.title)\n\($0)" } ?? session.title
            notifications.append(SessionOutcomeNotification(sessionId: session.id, outcomeAt: version, title: title, body: body))
        }
        defaults.set(observed, forKey: observedKey)
        return notifications
    }
}
