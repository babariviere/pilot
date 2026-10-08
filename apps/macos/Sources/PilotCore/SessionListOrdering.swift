import Foundation

extension SessionSummary {
    /// The current branch's PR has settled and so has every earlier one.
    public var hasTerminalPullRequest: Bool {
        guard pullRequest?.isTerminal == true else { return false }
        return linkedPullRequests.allSatisfy(\.isTerminal)
    }

    /// Working sessions retain their live activity behavior. Settled results use stable user/finish
    /// times instead of metadata updates (parking, PR polling, reviewing, or model changes).
    public var listActivityAt: Double {
        if isWorking { return updatedAt.isFinite ? updatedAt : createdAt }
        let userAt = lastUserMessageAt.flatMap { $0.isFinite ? $0 : nil }
        let finishAt = visibleOutcomeAt
        if let stableAt = [userAt, finishAt].compactMap({ $0 }).max() { return stableAt }
        return updatedAt.isFinite ? updatedAt : createdAt
    }

    /// One ordering for snapshots, deltas, fixture lists, sidebar, dashboard and menu bar.
    /// Pinned chats come first, then unsettled PRs and stable activity within each group.
    public static func listPrecedes(_ lhs: SessionSummary, _ rhs: SessionSummary) -> Bool {
        if lhs.isPinned != rhs.isPinned { return lhs.isPinned }
        if lhs.hasTerminalPullRequest != rhs.hasTerminalPullRequest { return !lhs.hasTerminalPullRequest }
        if lhs.listActivityAt != rhs.listActivityAt { return lhs.listActivityAt > rhs.listActivityAt }
        if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
        return lhs.id < rhs.id
    }
}
