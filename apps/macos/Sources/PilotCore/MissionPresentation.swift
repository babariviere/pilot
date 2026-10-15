import Foundation

// Pure mission presentation logic: Needs you, task grouping and ordering, sidebar order.

/// Something in a mission waiting on the user.
public enum MissionNeedsYouItem: Identifiable, Equatable, Sendable {
    /// A member chat with an unread result (done or failed).
    case chat(SessionSummary)
    case blockedTask(MissionTask)
    /// An open agent comment addressed to nobody while the user coordinates.
    case comment(MissionComment)
    case decisionProposal(MissionDecisionProposal, number: Int)

    public var id: String {
        switch self {
        case let .chat(session): "chat-\(session.id)"
        case let .blockedTask(task): "task-\(task.id)"
        case let .comment(comment): "comment-\(comment.id)"
        case let .decisionProposal(proposal, _): "proposal-\(proposal.id)"
        }
    }
}

public enum MissionNeedsYou {
    /// Sidebar badges use only the summary and the session list, never full mission detail.
    public static func count(
        mission: Mission, members: [SessionSummary], isUnread: (SessionSummary) -> Bool
    ) -> Int {
        (mission.needsYouCount ?? 0) + unreadChats(mission: mission, members: members, isUnread: isUnread).count
    }

    private static func unreadChats(
        mission: Mission, members: [SessionSummary], isUnread: (SessionSummary) -> Bool
    ) -> [SessionSummary] {
        members
            .filter { $0.missionId == mission.id && !$0.isArchived }
            .filter { session in
                session.attentionReason?.kind.isLive == true || session.attentionReason?.kind == .prStuck
                    || (!session.isWorking && (session.outcome == .done || session.outcome == .failed)
                        && isUnread(session) && session.signal(unread: true)?.needsUser == true)
            }
    }

    /// Member chats come from the session list; `detail` is nil until the mission's detail is loaded.
    public static func items(
        mission: Mission, detail: MissionDetail?, members: [SessionSummary],
        isUnread: (SessionSummary) -> Bool
    ) -> [MissionNeedsYouItem] {
        var items: [MissionNeedsYouItem] = unreadChats(mission: mission, members: members, isUnread: isUnread)
            .map { .chat($0) }
        guard let detail else { return items }
        items += MissionTaskOrdering.sorted(detail.tasks).filter { $0.status == .blocked }.map { .blockedTask($0) }
        if mission.coordinatorSessionId == nil {
            // The user's own comments are not waiting on the user.
            items += detail.comments
                .filter { $0.isOpen && $0.targetSessionId == nil && $0.authorSessionId != nil }
                .map { .comment($0) }
        }
        items += (detail.decisionProposals ?? []).filter { $0.status == "pending" }.compactMap { proposal in
            guard let decision = detail.decisions.first(where: { $0.id == proposal.decisionId }) else { return nil }
            return .decisionProposal(proposal, number: decision.number)
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
    public static let groupOrder: [MissionTaskStatus] = [.inProgress, .inReview, .blocked, .todo, .delegated, .done, .dropped]

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

    /// The Overview's Working now tasks: in progress, then in review, then blocked, each in task order.
    public static func inFlight(_ tasks: [MissionTask]) -> [MissionTask] {
        groups(tasks).filter { [.inProgress, .inReview, .blocked].contains($0.status) }.flatMap(\.tasks)
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

/// A mission's sidebar row: a progress line and the most urgent state of its chats. Missions are not chats,
/// so the row summarises its members instead of listing them.
public enum MissionSidebarSummary {
    /// "3 of 12 tasks · 2 working". Nil when there is nothing to say (no task counts from an older daemon,
    /// and no working chat).
    public static func progress(mission: Mission, working: Int) -> String? {
        var parts: [String] = []
        if let total = mission.tasksTotal {
            if total == 0 {
                parts.append("No tasks")
            } else {
                let done = min(max(mission.tasksDone ?? 0, 0), total)
                parts.append("\(done) of \(total) \(total == 1 ? "task" : "tasks")")
            }
        }
        if working > 0 { parts.append("\(working) working") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Sidebar urgency order: failed, then needs you, ready to merge and working. A blocked task or an open
    /// comment for the user (`Mission.needsYouCount`) makes the mission need the user even when no chat does.
    public static func signal(mission: Mission, members: [SessionSummary],
                              isUnread: (SessionSummary) -> Bool) -> SessionSignal? {
        let signals = Set(members.filter { $0.missionId == mission.id && !$0.isArchived }
            .compactMap { $0.signal(unread: isUnread($0)) })
        if signals.contains(.failed) { return .failed }
        if signals.contains(.needsYou) || (mission.needsYouCount ?? 0) > 0 { return .needsYou }
        if signals.contains(.readyToMerge) { return .readyToMerge }
        if signals.contains(.working) { return .working }
        return nil
    }

    /// The mission's working chats are all idle agents waiting on background jobs, so a working corner uses the
    /// slower background motion.
    public static func waitingOnJobs(mission: Mission, members: [SessionSummary]) -> Bool {
        let working = members.filter { $0.missionId == mission.id && !$0.isArchived && $0.isWorking }
        return !working.isEmpty && working.allSatisfy(\.isWaitingOnJobs)
    }
}

/// The second line of a coordinator's sidebar row: "Coordinator", then its reason or state.
public enum MissionCoordinatorStatus {
    public static func detail(_ session: SessionSummary, unread: Bool) -> String {
        if let reason = session.needsYouReason(unread: unread), reason.kind.isLive {
            return reason.label(at: session.attentionAt ?? session.updatedAt)
        }
        switch session.status {
        case .working: return "Working"
        case .paused, .usagePaused: return session.status.rawValue
        case .question: return firstLine(session.outcomeReason).map { "Asks: \($0)" } ?? "Asks a question"
        case .failed:
            return firstLine(session.outcomeReason ?? session.error).map { "Failed: \($0)" } ?? "Failed"
        case .stopped: return "Stopped"
        case .done, .idle: return unread && session.outcome == .done ? "New result" : "Idle"
        }
    }

    private static func firstLine(_ text: String?) -> String? {
        guard let line = text?.split(whereSeparator: \.isNewline).first?
            .trimmingCharacters(in: .whitespaces), !line.isEmpty else { return nil }
        return line
    }
}

/// Task counts by status. Dropped tasks are excluded, as in `MissionDetail.progress`.
public struct MissionTaskCounts: Equatable, Sendable {
    public let byStatus: [MissionTaskStatus: Int]

    public init(_ tasks: [MissionTask]) {
        var counts: [MissionTaskStatus: Int] = [:]
        for task in tasks where task.status != .dropped { counts[task.status, default: 0] += 1 }
        byStatus = counts
    }

    public var done: Int { byStatus[.done] ?? 0 }
    public var total: Int { byStatus.values.reduce(0, +) }
    public subscript(status: MissionTaskStatus) -> Int { byStatus[status] ?? 0 }

    /// Progress in words for the Overview's meta line: "12 of 18 done · 3 working now".
    public func progressLine(working: Int = 0) -> String {
        guard total > 0 else { return "No tasks yet" }
        let finished = "\(done) of \(total) done"
        return working > 0 ? "\(finished) · \(working) working now" : finished
    }

    /// Progress bar order: finished work first, then review, active, blocked and waiting work.
    public static let barOrder: [MissionTaskStatus] = [.done, .inReview, .inProgress, .blocked, .todo, .delegated]

    /// Legend entries in `barOrder`, zero counts omitted.
    public var legend: [(status: MissionTaskStatus, count: Int)] {
        Self.barOrder.compactMap { status in self[status] > 0 ? (status, self[status]) : nil }
    }

    /// The legend in words: "9 done · 2 in review · 3 in progress · 1 blocked · 3 to do".
    public var legendLine: String {
        legend.map { "\($0.count) \($0.status.label.lowercased())" }.joined(separator: " · ")
    }
}

/// Progress of one milestone (a phase, until phases are first-class).
public struct MissionMilestoneProgress: Identifiable, Equatable, Sendable {
    /// Nil groups tasks without a milestone.
    public let name: String?
    public let counts: MissionTaskCounts
    public var id: String { name ?? "" }
}

public enum MissionMilestones {
    /// A task's milestone, or nil when it names none (blank counts as none).
    public static func name(of task: MissionTask) -> String? {
        task.milestone.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }

    /// Milestones in the order their first task appears. Empty unless at least one task names a milestone;
    /// tasks without one are then grouped last. Milestones whose tasks are all dropped are omitted.
    public static func progress(_ tasks: [MissionTask]) -> [MissionMilestoneProgress] {
        let ordered = MissionTaskOrdering.sorted(tasks)
        var names: [String] = []
        for task in ordered { if let name = name(of: task), !names.contains(name) { names.append(name) } }
        guard !names.isEmpty else { return [] }
        let named = names.map { milestone in
            MissionMilestoneProgress(name: milestone, counts: MissionTaskCounts(ordered.filter { name(of: $0) == milestone }))
        }
        let rest = MissionMilestoneProgress(name: nil, counts: MissionTaskCounts(ordered.filter { name(of: $0) == nil }))
        return (named + [rest]).filter { $0.counts.total > 0 }
    }
}

/// One phase of the Tasks tab. Until phases are first-class, a phase is a milestone.
public struct MissionPhaseGroup: Identifiable, Equatable, Sendable {
    /// The milestone; nil for tasks without one, and for the flat list of a mission without milestones.
    public let name: String?
    /// Shown tasks: active work, delegated work, done, then dropped when shown, in task order within each status.
    public let tasks: [MissionTask]
    /// Progress of the phase; dropped tasks are excluded, as everywhere else.
    public let counts: MissionTaskCounts
    /// The phase's dropped tasks, shown or not.
    public let dropped: Int

    public var id: String { Self.id(name) }
    public var title: String { name ?? "No phase" }
    /// Every task is done or dropped, so the phase starts folded.
    public var isFinished: Bool { counts.done == counts.total }
    /// "12/18 done", or "2 dropped" for a phase whose every task was dropped.
    public var progress: String { counts.total > 0 ? "\(counts.done)/\(counts.total) done" : "\(dropped) dropped" }

    static func id(_ name: String?) -> String { "phase-" + (name ?? "") }
    /// The id of the phase a task belongs to, for "Show task".
    public static func id(of task: MissionTask) -> String { id(MissionMilestones.name(of: task)) }
}

/// The Tasks tab's phases, in the order of `MissionMilestones.progress`: first appearance in task order, then
/// tasks without a milestone last under "No phase". A mission without milestones is one flat list.
public struct MissionTaskPhases: Equatable, Sendable {
    public let groups: [MissionPhaseGroup]
    /// No task names a milestone, so the list has no phase headers.
    public let isFlat: Bool
    /// Dropped tasks across the mission, shown or not.
    public let dropped: Int

    /// Within a phase: in progress, in review, blocked and to do, delegated, done, then dropped.
    private static let statusOrder: [MissionTaskStatus: Int] = Dictionary(
        uniqueKeysWithValues: MissionTaskOrdering.groupOrder.enumerated().map { ($1, $0) })

    public init(_ tasks: [MissionTask], showDropped: Bool) {
        let ordered = MissionTaskOrdering.sorted(tasks)
        var names: [String?] = []
        var byPhase: [String?: [MissionTask]] = [:]
        for task in ordered {
            let name = MissionMilestones.name(of: task)
            if byPhase[name] == nil, name != nil { names.append(name) }
            byPhase[name, default: []].append(task)
        }
        names.append(nil)
        let rank = Self.statusOrder
        var groups: [MissionPhaseGroup] = []
        for name in names {
            guard let all = byPhase[name] else { continue }
            // A stable sort keeps task order within each status.
            let shown = all.filter { showDropped || $0.status != .dropped }
                .enumerated()
                .sorted { (rank[$0.element.status] ?? 0, $0.offset) < (rank[$1.element.status] ?? 0, $1.offset) }
                .map(\.element)
            guard !shown.isEmpty else { continue }
            groups.append(MissionPhaseGroup(name: name, tasks: shown, counts: MissionTaskCounts(all),
                                            dropped: all.count(where: { $0.status == .dropped })))
        }
        isFlat = groups.allSatisfy { $0.name == nil }
        self.groups = groups
        dropped = tasks.count(where: { $0.status == .dropped })
    }
}

/// Which phases are folded. Finished phases start folded; the user's choices then hold across refreshes.
public struct MissionPhaseFolds: Equatable, Sendable {
    private var choices: [String: Bool] = [:]

    public init() {}

    public func isFolded(_ group: MissionPhaseGroup) -> Bool { choices[group.id] ?? group.isFinished }

    public mutating func toggle(_ group: MissionPhaseGroup) { choices[group.id] = !isFolded(group) }

    /// Opens a phase by id, for "Show task".
    public mutating func unfold(_ id: String) { choices[id] = false }
}

public enum MissionMembers {
    /// An active mission's coordinator precedes pins, PR state and activity; otherwise use session order.
    /// Only orders the supplied members, so filtered or archived chats are not reintroduced.
    public static func members(of mission: Mission, in sessions: [SessionSummary]) -> [SessionSummary] {
        sessions.filter { $0.missionId == mission.id }.sorted { lhs, rhs in
            let lhsCoordinates = mission.status == .active && lhs.id == mission.coordinatorSessionId
            let rhsCoordinates = mission.status == .active && rhs.id == mission.coordinatorSessionId
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
