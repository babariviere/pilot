import Foundation

// Mirrors packages/protocol NeedsYouReason.
public enum NeedsYouReasonKind: String, LenientStringEnum {
    case failed, asks, mission, limit
    case notReviewed = "not_reviewed"
    case couldntStart = "couldnt_start"
    case longJob = "long_job"
    case prStuck = "pr_stuck"
    /// The chat reached for an MCP server that needs the user (sign-in, or it fails to connect). Live-only.
    case mcp
    public static let fallback = NeedsYouReasonKind.notReviewed

    /// Live attention that holds while the chat works and outranks its outcome until it clears.
    public var isLive: Bool { self == .longJob || self == .mcp }
}

public struct NeedsYouReason: Codable, Hashable, Sendable {
    public let kind: NeedsYouReasonKind
    public let detail: String?
    /// `limit`: epoch milliseconds when the used-up subscription window resets, when known.
    public let resumesAt: Double?
    /// `mcp`: the server to fix, by its mcp.json name.
    public let server: String?

    public init(kind: NeedsYouReasonKind, detail: String? = nil, resumesAt: Double? = nil, server: String? = nil) {
        self.kind = kind
        self.detail = Self.firstLine(detail)
        self.resumesAt = resumesAt
        self.server = server
    }

    public func label(at: Double, now: Date = Date()) -> String {
        let detail = Self.firstLine(detail)
        switch kind {
        case .failed: return "Failed: \(detail ?? "The chat failed")"
        case .asks: return "Asks: \(detail ?? "A question is waiting for your answer")"
        case .couldntStart: return "Couldn't start: \(detail ?? "The scheduled chat could not start")"
        case .longJob: return "Long job: \(detail ?? "A background job has run for over an hour")"
        case .mcp: return "MCP: \(detail ?? "A server this chat uses needs you")"
        case .prStuck: return detail ?? "A pull request needs your help"
        case .mission: return "Mission: \(detail ?? "A question or blocked task is waiting on you")"
        case .limit:
            guard let resumesAt, resumesAt.isFinite else { return "Limit reached" }
            let date = Date(timeIntervalSince1970: resumesAt / 1000)
            return "Limit reached · resumes \(UsageFormatting.clock(date, now: now))"
        case .notReviewed:
            return "Not reviewed: finished \(RelativeDate.ago(at.isFinite ? at : now.timeIntervalSince1970 * 1000, now: now))"
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
        case .longJob: return NeedsYouReason(kind: .longJob, detail: reason)
        case .mcp: return NeedsYouReason(kind: .mcp, detail: reason)
        case .prStuck: return NeedsYouReason(kind: .prStuck, detail: reason)
        }
    }

    public func needsYouLabel(now: Date = Date()) -> String { needsYouReason.label(at: at, now: now) }
}

extension SessionSummary {
    /// Derive sidebar reasons from the same outcome fields pilotd uses. `unread` includes awaiting-reply rows.
    public func needsYouReason(unread: Bool, now: Date = Date()) -> NeedsYouReason? {
        guard signal(unread: unread)?.needsUser == true else { return nil }
        if let attentionReason, attentionReason.kind.isLive { return attentionReason }
        if status == .failed {
            if let limit = subscriptionLimit(now: now) { return limit }
            return NeedsYouReason(kind: .failed, detail: NeedsYouReason.firstLine(outcomeReason) ?? error)
        }
        if status == .question { return NeedsYouReason(kind: .asks, detail: outcomeReason) }
        if let attentionReason { return attentionReason }
        return NeedsYouReason(kind: .notReviewed)
    }

    /// Same rule as pilotd: a failure whose error reads as a usage or rate limit, or whose provider has a window
    /// used up that has not reset yet. Resumes when the latest used-up window resets.
    public func subscriptionLimit(now: Date = Date()) -> NeedsYouReason? {
        var resets: [Date] = []
        var exhausted = false
        for window in usage?.subscription?.windows ?? [] where !window.isExtra && window.usedPercent >= 100 {
            let reset = window.resetDate
            if let reset, reset <= now { continue }
            exhausted = true
            if let reset { resets.append(reset) }
        }
        let text = "\(outcomeReason ?? "")\n\(error ?? "")"
        guard exhausted || text.range(of: Self.limitError, options: [.regularExpression, .caseInsensitive]) != nil
        else { return nil }
        return NeedsYouReason(kind: .limit, resumesAt: resets.max().map { $0.timeIntervalSince1970 * 1000 })
    }

    private static let limitError = #"usage[ _-]?limit|rate[ _-]?limit|limit reached|quota|too many requests|\b429\b"#
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
        let vocabulary = [("long_job", "long job", "long jobs"), ("mcp", "MCP sign-in", "MCP sign-ins"),
                          ("asks", "question", "questions"), ("failed", "failed", "failed"),
                          ("pr_stuck", "stuck PR", "stuck PRs"),
                          ("not_reviewed", "not reviewed", "not reviewed"),
                          ("couldnt_start", "couldn't start", "couldn't start"),
                          ("limit", "limit reached", "limits reached"),
                          ("mission", "mission", "missions")]
        let parts = vocabulary.compactMap { key, singular, plural -> String? in
            let number = reasons[key, default: 0]
            return number > 0 ? "\(number) \(number == 1 ? singular : plural)" : nil
        }
        let lead = "\(total) \(total == 1 ? "needs" : "need") you"
        return parts.isEmpty ? lead : "\(lead): \(parts.joined(separator: ", "))"
    }
}
