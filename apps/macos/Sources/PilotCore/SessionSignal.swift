import Foundation

/// The one state a sidebar row signals, drawn as its dithered corner. nil rows are quiet and draw nothing.
/// Order of precedence follows DESIGN.md's attention budget: live work, then failures, then unread results,
/// then pull requests ready to merge.
public enum SessionSignal: String, CaseIterable, Hashable, Sendable {
    case working
    case failed
    case needsYou
    case readyToMerge

    /// The state vocabulary label, used for help text and VoiceOver.
    public var label: String {
        switch self {
        case .working: "Working"
        case .failed: "Failed"
        case .needsYou: "Needs you"
        case .readyToMerge: "Ready to merge"
        }
    }

    /// Failed chats and unread results need the user. Working and ready-to-merge chats wait on the page.
    public var needsUser: Bool { self == .failed || self == .needsYou }
}

extension SessionSummary {
    /// The chat's current PR is open, not a draft, and GitHub reports no blockers.
    public var isReadyToMerge: Bool {
        guard !isMissionCoordinator, let pullRequest, pullRequest.state == .open else { return false }
        return pullRequest.readiness?.state == .ready
    }

    /// `unread` comes from the client's review marks (`SessionAttention.isUnread`).
    public func signal(unread: Bool) -> SessionSignal? {
        if attentionReason?.kind == .longJob { return .needsYou }
        if isWorking { return .working }
        if status == .failed && !hasTerminalPullRequest { return .failed }
        // A question waits on the user until answered, even once viewed or after its PRs settled.
        if unread || status == .question { return .needsYou }
        if isReadyToMerge { return .readyToMerge }
        return nil
    }

    /// Finished and reviewed, with no live work, failure, open PR or active coordination. Quiet chats are the
    /// only ones a long sidebar list folds away.
    public var isQuiet: Bool {
        !isWorking && !isActiveMissionCoordinator && status != .failed && status != .question
            && !linkedPullRequests.contains { !$0.isTerminal }
    }
}

/// The All projects sidebar grouped by urgency instead of by project.
public enum SidebarUrgency {
    public struct Groups: Equatable, Sendable {
        /// Failed chats first, then agent questions, then unread or unanswered results, each in list order.
        public var needsYou: [SessionSummary] = []
        public var working: [SessionSummary] = []
        /// Everything else, in list order (pinned first).
        public var recent: [SessionSummary] = []

        public init(needsYou: [SessionSummary] = [], working: [SessionSummary] = [], recent: [SessionSummary] = []) {
            self.needsYou = needsYou
            self.working = working
            self.recent = recent
        }

        public var isEmpty: Bool { needsYou.isEmpty && working.isEmpty && recent.isEmpty }
    }

    /// One pass over `sessions`, which are already in sidebar list order. `awaitingReply` keeps a viewed result
    /// under Needs you, so opening a chat does not move it to Recent.
    public static func groups(_ sessions: [SessionSummary], unread: (SessionSummary) -> Bool,
                              awaitingReply: (SessionSummary) -> Bool = { _ in false }) -> Groups {
        var failed: [SessionSummary] = []
        var questions: [SessionSummary] = []
        var waiting: [SessionSummary] = []
        var groups = Groups()
        for session in sessions {
            switch session.signal(unread: unread(session)) {
            case .working: groups.working.append(session)
            case .failed: failed.append(session)
            case .needsYou where session.status == .question: questions.append(session)
            case .needsYou: waiting.append(session)
            case .readyToMerge, nil:
                if awaitingReply(session) { waiting.append(session) } else { groups.recent.append(session) }
            }
        }
        groups.needsYou = failed + questions + waiting
        return groups
    }
}
