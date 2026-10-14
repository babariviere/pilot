import Foundation

/// Folds quiet chats in long sidebar lists without hiding anything that needs the user or is in progress.
public enum SidebarSessionList {
    /// Leading rows shown even when they are quiet.
    public static let defaultLimit = 5

    /// The sessions to show, in their original order, and how many fold away.
    /// Pinned chats, chats that are not quiet (working, failed, open PRs, active coordination) and chats matching
    /// `keep` (selected, unread or ready to merge) always stay visible. Only quiet chats past `limit` fold away.
    /// Lists with at most `limit + 1` rows stay whole, since the toggle would take a row's place.
    public static func collapsed(_ sessions: [SessionSummary], limit: Int = defaultLimit,
                                 keep: (SessionSummary) -> Bool) -> (shown: [SessionSummary], hidden: Int) {
        guard sessions.count > limit + 1 else { return (sessions, 0) }
        var folded: [Int] = []
        for index in sessions.indices where index >= limit {
            let session = sessions[index]
            if session.isQuiet && !session.isPinned && !keep(session) {
                folded.append(index)
            }
        }
        // Most lists contain only active chats. Reuse their array rather than copying every summary.
        guard !folded.isEmpty else { return (sessions, 0) }
        var shown: [SessionSummary] = []
        shown.reserveCapacity(sessions.count - folded.count)
        var nextFolded = 0
        for index in sessions.indices {
            if nextFolded < folded.count, index == folded[nextFolded] {
                nextFolded += 1
            } else {
                shown.append(sessions[index])
            }
        }
        return (shown, folded.count)
    }
}
