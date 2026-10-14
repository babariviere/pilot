import Foundation

// Mirrors packages/protocol NeedsYouReason. Long-job attention is added separately.
public enum NeedsYouReasonKind: String, LenientStringEnum {
    case failed, asks, mission
    case notReviewed = "not_reviewed"
    case couldntStart = "couldnt_start"
    public static let fallback = NeedsYouReasonKind.notReviewed
}

public struct NeedsYouReason: Codable, Equatable, Sendable {
    public let kind: NeedsYouReasonKind
    public let detail: String?

    public init(kind: NeedsYouReasonKind, detail: String? = nil) {
        self.kind = kind
        self.detail = Self.firstLine(detail)
    }

    public func label(at: Double, now: Date = Date()) -> String {
        let detail = Self.firstLine(detail)
        switch kind {
        case .failed: return "Failed: \(detail ?? "The chat failed")"
        case .asks: return "Asks: \(detail ?? "A question is waiting for your answer")"
        case .couldntStart: return "Couldn't start: \(detail ?? "The scheduled chat could not start")"
        case .mission: return "Mission: \(detail ?? "A question or blocked task is waiting on you")"
        case .notReviewed:
            let age = SessionTimeFormatting.relative(at.isFinite ? at : now.timeIntervalSince1970 * 1000, now: now)
            return "Not reviewed: finished \(age == "now" ? "just now" : "\(age) ago")"
        }
    }

    /// Same single-line bound as pilotd, including for legacy daemon diagnostics.
    public static func firstLine(_ text: String?) -> String? {
        guard let text else { return nil }
        for candidate in text.components(separatedBy: .newlines) {
            let line = candidate.trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { return line.count > 200 ? "\(line.prefix(199))…" : line }
        }
        return nil
    }
}

extension DashboardNeedsYouItem {
    public var needsYouReason: NeedsYouReason {
        if let attentionReason { return attentionReason }
        switch kind {
        case .failed: return NeedsYouReason(kind: .failed, detail: reason)
        case .question: return NeedsYouReason(kind: sessionId == nil ? .mission : .asks, detail: reason)
        case .scheduledFailed: return NeedsYouReason(kind: .couldntStart, detail: reason)
        case .unread: return NeedsYouReason(kind: .notReviewed)
        }
    }

    public func needsYouLabel(now: Date = Date()) -> String { needsYouReason.label(at: at, now: now) }
}

extension SessionSummary {
    /// Derive sidebar reasons from the same outcome fields pilotd uses. `unread` includes awaiting-reply rows.
    public func needsYouReason(unread: Bool) -> NeedsYouReason? {
        guard signal(unread: unread)?.needsUser == true else { return nil }
        if status == .failed {
            return NeedsYouReason(kind: .failed, detail: NeedsYouReason.firstLine(outcomeReason) ?? error)
        }
        if status == .question { return NeedsYouReason(kind: .asks, detail: outcomeReason) }
        return NeedsYouReason(kind: .notReviewed)
    }
}

extension MissionNeedsYouItem {
    public func needsYouLabel(now: Date = Date()) -> String {
        switch self {
        case let .chat(session):
            let reason = session.needsYouReason(unread: true) ?? NeedsYouReason(kind: .notReviewed)
            return reason.label(at: session.outcomeAt ?? session.updatedAt, now: now)
        case let .blockedTask(task):
            return NeedsYouReason(kind: .mission, detail: "Blocked: #\(task.number) \(task.title)").label(at: task.updatedAt, now: now)
        case let .comment(comment):
            return NeedsYouReason(kind: .mission, detail: comment.text).label(at: comment.createdAt, now: now)
        case let .decisionProposal(proposal, number):
            return NeedsYouReason(kind: .mission, detail: "Decision D\(number): \(proposal.reason)").label(at: proposal.createdAt, now: now)
        }
    }
}

extension InboxText {
    /// Summarize uncapped counts, never just the Inbox's first page. Unknown future reasons stay in the total.
    public static func needsYouSummary(_ counts: [ProjectDashboardCount]) -> String {
        let total = counts.reduce(0) { $0 + $1.needsYou }
        var reasons: [String: Int] = [:]
        for count in counts {
            for (kind, number) in count.needsYouReasons ?? [:] { reasons[kind, default: 0] += number }
        }
        let vocabulary = [("asks", "question", "questions"), ("failed", "failed", "failed"),
                          ("not_reviewed", "not reviewed", "not reviewed"),
                          ("couldnt_start", "couldn't start", "couldn't start"),
                          ("mission", "mission", "missions")]
        let parts = vocabulary.compactMap { key, singular, plural -> String? in
            let number = reasons[key, default: 0]
            return number > 0 ? "\(number) \(number == 1 ? singular : plural)" : nil
        }
        let lead = "\(total) \(total == 1 ? "needs" : "need") you"
        return parts.isEmpty ? lead : "\(lead): \(parts.joined(separator: ", "))"
    }
}
