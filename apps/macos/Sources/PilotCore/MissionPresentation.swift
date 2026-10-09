import Foundation

// Pure mission presentation logic: Needs you, task grouping and ordering, sidebar order.

/// Something in a mission waiting on the user.
public enum MissionNeedsYouItem: Identifiable, Equatable, Sendable {
    /// A member chat with an unread result (done or failed).
    case chat(SessionSummary)
    case blockedTask(MissionTask)
    /// An open agent comment addressed to nobody while the user coordinates.
    case comment(MissionComment)

    public var id: String {
        switch self {
        case let .chat(session): "chat-\(session.id)"
        case let .blockedTask(task): "task-\(task.id)"
        case let .comment(comment): "comment-\(comment.id)"
        }
    }
}

public enum MissionNeedsYou {
    /// Member chats come from the session list; `detail` is nil until the mission's detail is loaded.
    public static func items(
        mission: Mission, detail: MissionDetail?, members: [SessionSummary],
        isUnread: (SessionSummary) -> Bool
    ) -> [MissionNeedsYouItem] {
        var items: [MissionNeedsYouItem] = members
            .filter { $0.missionId == mission.id && !$0.isArchived && !$0.isWorking }
            .filter { ($0.outcome == .done || $0.outcome == .failed) && isUnread($0) }
            .map { .chat($0) }
        guard let detail else { return items }
        items += MissionTaskOrdering.sorted(detail.tasks).filter { $0.status == .blocked }.map { .blockedTask($0) }
        if mission.coordinatorSessionId == nil {
            // The user's own comments are not waiting on the user.
            items += detail.comments
                .filter { $0.isOpen && $0.targetSessionId == nil && $0.authorSessionId != nil }
                .map { .comment($0) }
        }
        return items
    }
}

public struct MissionTaskGroup: Identifiable, Equatable, Sendable {
    public let status: MissionTaskStatus
    public let tasks: [MissionTask]
    public var id: String { status.rawValue }
}

public enum MissionTaskOrdering {
    /// Display order of status groups: active work first, closed work last.
    public static let groupOrder: [MissionTaskStatus] = [.inProgress, .inReview, .blocked, .todo, .done, .dropped]

    public static func sorted(_ tasks: [MissionTask]) -> [MissionTask] {
        tasks.sorted { ($0.order, $0.number) < ($1.order, $1.number) }
    }

    /// Non-empty status groups, each in task order.
    public static func groups(_ tasks: [MissionTask]) -> [MissionTaskGroup] {
        let ordered = sorted(tasks)
        return groupOrder.compactMap { status in
            let matching = ordered.filter { $0.status == status }
            return matching.isEmpty ? nil : MissionTaskGroup(status: status, tasks: matching)
        }
    }

    public struct Update: Equatable, Sendable {
        public let taskId: String
        public let order: Double
        public init(taskId: String, order: Double) {
            self.taskId = taskId
            self.order = order
        }
    }

    /// Order updates that move `taskId` by `offset` positions within `tasks` (a displayed list, any order).
    /// Usually one update between the new neighbours; renumbers the list when their keys leave no room.
    public static func move(_ taskId: String, by offset: Int, in tasks: [MissionTask]) -> [Update] {
        var list = sorted(tasks)
        guard let from = list.firstIndex(where: { $0.id == taskId }) else { return [] }
        let to = min(max(from + offset, 0), list.count - 1)
        guard to != from else { return [] }
        let task = list.remove(at: from)
        list.insert(task, at: to)
        let previous = to > 0 ? list[to - 1].order : nil
        let next = to + 1 < list.count ? list[to + 1].order : nil
        let candidate: Double
        switch (previous, next) {
        case let (p?, n?): candidate = (p + n) / 2
        case let (p?, nil): candidate = p + 1
        case let (nil, n?): candidate = n - 1
        case (nil, nil): return []
        }
        let fits = (previous.map { candidate > $0 } ?? true) && (next.map { candidate < $0 } ?? true)
        if fits { return [Update(taskId: taskId, order: candidate)] }
        let base = min(list.map(\.order).min() ?? 0, 0)
        return list.enumerated().compactMap { index, task in
            let order = base + Double(index + 1)
            return task.order == order ? nil : Update(taskId: task.id, order: order)
        }
    }

    /// Order key for a task appended after every existing one.
    public static func nextOrder(after tasks: [MissionTask]) -> Double {
        (tasks.map(\.order).max() ?? 0) + 1
    }
}

public extension Collection where Element == Mission {
    /// Sidebar order: newest first.
    var sidebarOrder: [Mission] { sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) } }
}

public enum MissionMembers {
    /// A mission's chats: the coordinator before pins, PR state and activity, then the session list order.
    /// Only orders the supplied members, so filtered or archived chats are not reintroduced.
    public static func members(of mission: Mission, in sessions: [SessionSummary]) -> [SessionSummary] {
        sessions.filter { $0.missionId == mission.id }.sorted { lhs, rhs in
            let lhsCoordinates = lhs.id == mission.coordinatorSessionId
            let rhsCoordinates = rhs.id == mission.coordinatorSessionId
            if lhsCoordinates != rhsCoordinates { return lhsCoordinates }
            return SessionSummary.listPrecedes(lhs, rhs)
        }
    }
}

/// How a task row names the chat that owns it. Chats started from a task take its title,
/// so repeating that title next to the task would only add noise.
public enum MissionTaskOwnerLabel {
    public static func text(task: MissionTask, chatTitle: String?) -> String {
        guard let title = chatTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
            return "Chat"
        }
        let same = title.compare(task.title.trimmingCharacters(in: .whitespacesAndNewlines),
                                 options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        return same ? "Chat" : title
    }

    public static func help(chatTitle: String?) -> String {
        chatTitle.map { "Open the chat “\($0)”" } ?? "Open the chat working on this task"
    }
}
