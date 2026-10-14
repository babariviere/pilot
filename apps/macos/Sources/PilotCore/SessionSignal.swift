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
        guard let pullRequest, pullRequest.state == .open else { return false }
        return pullRequest.readiness?.state == .ready
    }

    /// `unread` comes from the client's review marks (`SessionAttention.isUnread`).
    public func signal(unread: Bool) -> SessionSignal? {
        if isWorking { return .working }
        if status == .failed && !hasTerminalPullRequest { return .failed }
        if unread { return .needsYou }
        if isReadyToMerge { return .readyToMerge }
        return nil
    }

    /// Finished and reviewed, with no live work, failure, open PR or active coordination. Quiet chats are the
    /// only ones a long sidebar list folds away.
    public var isQuiet: Bool {
        !isWorking && !isActiveMissionCoordinator && status != .failed
            && !linkedPullRequests.contains { !$0.isTerminal }
    }
}

/// The All projects sidebar grouped by urgency instead of by project.
public enum SidebarUrgency {
    public struct Groups: Equatable, Sendable {
        /// Failed chats first, then unread results, each in list order.
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

    /// One pass over `sessions`, which are already in sidebar list order.
    public static func groups(_ sessions: [SessionSummary], unread: (SessionSummary) -> Bool) -> Groups {
        var failed: [SessionSummary] = []
        var waiting: [SessionSummary] = []
        var groups = Groups()
        for session in sessions {
            switch session.signal(unread: unread(session)) {
            case .working: groups.working.append(session)
            case .failed: failed.append(session)
            case .needsYou: waiting.append(session)
            case .readyToMerge, nil: groups.recent.append(session)
            }
        }
        groups.needsYou = failed + waiting
        return groups
    }
}
