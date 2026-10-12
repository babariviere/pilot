import Foundation

/// Caps long sidebar session lists so one busy project does not crowd out the others.
public enum SidebarSessionList {
    /// Rows shown before the rest fold behind a "Show more" row.
    public static let defaultLimit = 5

    /// The sessions to show, in their original order, and how many fold away.
    /// Pinned chats and chats matching `keep` (selected, working or unread) always stay visible.
    /// Lists that would fold only one row stay whole, since the toggle would take its place.
    public static func collapsed(_ sessions: [SessionSummary], limit: Int = defaultLimit,
                                 keep: (SessionSummary) -> Bool) -> (shown: [SessionSummary], hidden: Int) {
        guard sessions.count > limit + 1 else { return (sessions, 0) }
        var shown: [SessionSummary] = []
        shown.reserveCapacity(limit)
        for (index, session) in sessions.enumerated() where index < limit || session.isPinned || keep(session) {
            shown.append(session)
        }
        return (shown, sessions.count - shown.count)
    }
}
