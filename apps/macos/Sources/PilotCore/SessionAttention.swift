import Foundation

public enum SessionOutcome: String, Codable, Sendable {
    case done
    case failed
    case stopped

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
    case done = "Done"
    case failed = "Failed"
    case stopped = "Stopped"
    case idle = "Idle"
}

extension SessionSummary {
    /// Outcome is independent of lifecycle, and is hidden only while working.
    public var status: SessionStatus {
        if isWorking { return .working }
        switch outcome {
        case .done: return .done
        case .failed: return .failed
        case .stopped: return .stopped
        case nil: return state == "failed" ? .failed : .idle
        }
    }

    public var visibleOutcomeAt: Double? {
        guard !isWorking, outcome != nil, let outcomeAt, outcomeAt.isFinite else { return nil }
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
public final class SessionAttention {
    private let defaults: UserDefaults
    private let reviewedKey = "pilot.reviewedOutcomeAt"
    private let observedKey = "pilot.observedOutcomeAt"
    private var reviewed: [String: Double]
    private var observed: [String: Double]
    private var receivedSnapshot = false

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        reviewed = defaults.dictionary(forKey: reviewedKey) as? [String: Double] ?? [:]
        observed = defaults.dictionary(forKey: observedKey) as? [String: Double] ?? [:]
    }

    public func isUnread(_ session: SessionSummary) -> Bool {
        guard !session.hasTerminalPullRequest else { return false }
        guard let version = session.visibleOutcomeAt else { return false }
        return reviewed[session.id].map { $0 < version } ?? true
    }

    @discardableResult
    public func review(_ session: SessionSummary, chatVisible: Bool, appActive: Bool, explicit: Bool = false) -> Bool {
        guard explicit || (chatVisible && appActive), isUnread(session), let version = session.visibleOutcomeAt else { return false }
        reviewed[session.id] = version
        defaults.set(reviewed, forKey: reviewedKey)
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
            case .done: title = "Session done"
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
