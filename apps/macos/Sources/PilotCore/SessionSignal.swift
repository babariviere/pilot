import Foundation

/// The one state a sidebar row signals, drawn as its dithered corner. nil rows are quiet and draw nothing.
/// Live work and actionable problems take precedence; a ready PR supersedes an unreviewed result.
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
        guard !isMissionCoordinator, attentionReason?.kind != .prStuck,
              let pullRequest, pullRequest.state == .open else { return false }
        return pullRequest.readiness?.state == .ready
    }

    /// `unread` comes from the client's review marks (`SessionAttention.isUnread`).
    public func signal(unread: Bool) -> SessionSignal? {
        if attentionReason?.kind.isLive == true { return .needsYou }
        if isWorking { return .working }
        if status == .failed && !hasTerminalPullRequest { return .failed }
        // A question waits on the user until answered, even once viewed or after its PRs settled.
        if status == .question || attentionReason?.kind == .prStuck { return .needsYou }
        if isReadyToMerge { return .readyToMerge }
        if unread { return .needsYou }
        return nil
    }

    /// Finished and reviewed, with no live work, failure, open PR or active coordination. Quiet chats are the
    /// only ones a long sidebar list folds away.
    public var isQuiet: Bool {
        !isWorking && offlinePaused != true && !isActiveMissionCoordinator && status != .failed && status != .question
            && !linkedPullRequests.contains { !$0.isTerminal }
    }
}

/// The sidebar's chat groups by urgency, for All projects and a focused project alike. Pinned chats lead in their own
/// group, above Needs you.
public enum SidebarUrgency {
    public struct Groups: Equatable, Sendable {
        /// Pinned chats in list order, whatever their state. A pinned chat is listed only here; its corner still
        /// shows its state.
        public var pinned: [SessionSummary] = []
        /// Failed chats first, then agent questions, then unread results (and read ones whose chat is still
        /// open), each in list order.
        public var needsYou: [SessionSummary] = []
        /// Chats whose PR is ready to merge, reviewed or not, in list order. Never badges.
        public var readyToMerge: [SessionSummary] = []
        public var working: [SessionSummary] = []
        /// Everything else, in list order.
        public var recent: [SessionSummary] = []

        public init(pinned: [SessionSummary] = [], needsYou: [SessionSummary] = [], readyToMerge: [SessionSummary] = [],
                    working: [SessionSummary] = [], recent: [SessionSummary] = []) {
            self.pinned = pinned
            self.needsYou = needsYou
            self.readyToMerge = readyToMerge
            self.working = working
            self.recent = recent
        }

        public var isEmpty: Bool {
            pinned.isEmpty && needsYou.isEmpty && readyToMerge.isEmpty && working.isEmpty && recent.isEmpty
        }
    }

    /// One pass over `sessions`, which are already in sidebar list order. `held` keeps a result read in the open
    /// chat under Needs you until the user leaves it (`SessionAttention.isHeld`), unless its PR is ready to merge.
    /// Working wins over a ready PR, so a chat still pushing to its PR stays under Working. With `separatingPinned`
    /// false, pinned chats join the group of their state, for counts that must match pilotd's.
    public static func groups(_ sessions: [SessionSummary], unread: (SessionSummary) -> Bool,
                              held: (SessionSummary) -> Bool = { _ in false },
                              separatingPinned: Bool = true) -> Groups {
        var failed: [SessionSummary] = []
        var questions: [SessionSummary] = []
        var waiting: [SessionSummary] = []
        var groups = Groups()
        for session in sessions {
            if separatingPinned, session.isPinned {
                groups.pinned.append(session)
                continue
            }
            switch session.signal(unread: unread(session)) {
            case .working: groups.working.append(session)
            case .failed: failed.append(session)
            case .needsYou where session.status == .question: questions.append(session)
            case .needsYou: waiting.append(session)
            case .readyToMerge: groups.readyToMerge.append(session)
            case nil:
                if held(session) { waiting.append(session) } else { groups.recent.append(session) }
            }
        }
        groups.needsYou = failed + questions + waiting
        return groups
    }
}
