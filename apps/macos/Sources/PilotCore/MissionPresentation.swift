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
    /// A managed Linear ticket whose updates are paused for review or failed.
    case linearTicket(MissionResource)

    public var id: String {
        switch self {
        case let .chat(session): "chat-\(session.id)"
        case let .blockedTask(task): "task-\(task.id)"
        case let .comment(comment): "comment-\(comment.id)"
        case let .decisionProposal(proposal, _): "proposal-\(proposal.id)"
        case let .linearTicket(resource): "linear-\(resource.id)"
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
        // Phase gating is shown on the task itself; it is planned waiting, not something for the user.
        items += MissionTaskOrdering.sorted(detail.tasks).filter { $0.workStatus == .blocked }.map { .blockedTask($0) }
        // Paused or failed Linear updates wait on the user's review; the ticket's row offers Resume or Retry.
        items += detail.resources.filter { resource in
            resource.taskId == nil && resource.effectiveLinearRole == .managed
                && (resource.linearSync?.state == .paused || resource.linearSync?.state == .error)
        }
        .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
        .map { .linearTicket($0) }
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

    /// Non-empty status groups, each in task order. Gated tasks keep their own status.
    public static func groups(_ tasks: [MissionTask]) -> [MissionTaskGroup] {
        let ordered = sorted(tasks)
        return groupOrder.compactMap { status in
            let matching = ordered.filter { $0.workStatus == status }
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
        MissionOrderKeys.move(taskId, by: offset, in: sorted(tasks).map { .init(id: $0.id, order: $0.order) })
            .map { Update(taskId: $0.id, order: $0.order) }
    }

    /// Order key for a task appended after every existing one.
    public static func nextOrder(after tasks: [MissionTask]) -> Double {
        (tasks.map(\.order).max() ?? 0) + 1
    }
}

/// Fractional sort keys shared by tasks and phases: a move writes one key between the new neighbours, and
/// renumbers the list only when their keys leave no room.
public enum MissionOrderKeys {
    public struct Key: Equatable, Sendable {
        public let id: String
        public let order: Double
        public init(id: String, order: Double) {
            self.id = id
            self.order = order
        }
    }

    /// Moves `id` by `offset` positions within `keys`, which are in display order.
    public static func move(_ id: String, by offset: Int, in keys: [Key]) -> [Key] {
        guard let from = keys.firstIndex(where: { $0.id == id }) else { return [] }
        return place(id, at: min(max(from + offset, 0), keys.count - 1), in: keys)
    }

    /// Moves `id` so it ends up at `destination` in `keys` (display order), counted after its removal.
    public static func place(_ id: String, at destination: Int, in keys: [Key]) -> [Key] {
        var list = keys
        guard let from = list.firstIndex(where: { $0.id == id }) else { return [] }
        let item = list.remove(at: from)
        let to = min(max(destination, 0), list.count)
        guard to != from else { return [] }
        list.insert(item, at: to)
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
        if fits { return [Key(id: id, order: candidate)] }
        let base = min(list.map(\.order).min() ?? 0, 0)
        return list.enumerated().compactMap { index, key in
            let order = base + Double(index + 1)
            return key.order == order ? nil : Key(id: key.id, order: order)
        }
    }
}

public extension Collection where Element == Mission {
    /// Sidebar order: newest first.
    var sidebarOrder: [Mission] { sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) } }
}

/// A mission's sidebar row: a progress line and the most urgent state of its chats. Missions are not chats,
/// so the row summarises its members instead of listing them.
public enum MissionSidebarSummary {
    /// The row's second line: the current phase, when there is one, then its progress (or the mission's) and
    /// working chats.
    public struct Line: Equatable, Sendable {
        /// The current phase's name. The row truncates it before the counts.
        public let phase: String?
        /// "3 of 8 tasks · 2 working".
        public let detail: String?

        public var text: String { [phase, detail].compactMap { $0 }.joined(separator: " · ") }
    }

    /// "Build · 3 of 8 tasks · 2 working" in the current phase, else "3 of 12 tasks · 2 working". Nil when there is
    /// nothing to say (no task counts from an older daemon, and no working chat).
    public static func line(mission: Mission, working: Int) -> Line? {
        var parts: [String] = []
        let phase = mission.currentPhase.flatMap { $0.total > 0 ? $0 : nil }
        if let phase {
            parts.append(tasks(done: phase.done, total: phase.total))
        } else if let total = mission.tasksTotal {
            if total == 0 {
                parts.append("No tasks")
            } else {
                parts.append(tasks(done: mission.tasksDone ?? 0, total: total))
            }
        }
        if working > 0 { parts.append("\(working) working") }
        guard phase != nil || !parts.isEmpty else { return nil }
        return Line(phase: phase?.name, detail: parts.isEmpty ? nil : parts.joined(separator: " · "))
    }

    /// The line as one string, for accessibility.
    public static func progress(mission: Mission, working: Int) -> String? {
        line(mission: mission, working: working)?.text
    }

    private static func tasks(done: Int, total: Int) -> String {
        "\(min(max(done, 0), total)) of \(total) \(total == 1 ? "task" : "tasks")"
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
        case .paused, .usagePaused, .offlinePaused: return session.status.rawValue
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
        // Gated tasks count by their own status: gating is planned waiting, not blocked work.
        for task in tasks where task.workStatus != .dropped { counts[task.workStatus, default: 0] += 1 }
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

public enum MissionMilestones {
    /// A task's milestone, or nil when it names none (blank counts as none).
    public static func name(of task: MissionTask) -> String? {
        task.milestone.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }
}

/// A mission's phases in order, and the phase each task belongs to. Without phases from the daemon (an older
/// pilotd), task milestones stand in for phases in the order their first task appears, with the name as id;
/// those cannot be edited.
public struct MissionPhaseIndex: Equatable, Sendable {
    public let phases: [MissionPhase]
    /// First-class phases, which the user can add, rename, reorder and delete, and move tasks between.
    public let isEditable: Bool
    private let positions: [String: Int]

    public init(phases: [MissionPhase]?, tasks: [MissionTask]) {
        if let phases {
            self.phases = phases.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
            isEditable = true
        } else {
            var names: [String] = []
            var seen = Set<String>()
            for task in MissionTaskOrdering.sorted(tasks) {
                if let name = MissionMilestones.name(of: task), seen.insert(name).inserted { names.append(name) }
            }
            self.phases = names.enumerated().map { index, name in
                MissionPhase(id: name, missionId: "", name: name, order: Double(index))
            }
            isEditable = false
        }
        positions = Dictionary(self.phases.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    public init(_ detail: MissionDetail) {
        self.init(phases: detail.phases, tasks: detail.tasks)
    }

    /// The phase a task belongs to. Nil for no phase, including a phase that no longer exists.
    public func phaseId(of task: MissionTask) -> String? {
        guard isEditable else { return MissionMilestones.name(of: task) }
        return task.phaseId.flatMap { positions[$0] == nil ? nil : $0 }
    }

    public func phase(id: String) -> MissionPhase? { positions[id].map { phases[$0] } }

    public func phase(of task: MissionTask) -> MissionPhase? { phaseId(of: task).flatMap(phase(id:)) }

    /// The unfinished earlier phases holding a gated task, in phase order. Unknown ids are skipped.
    public func gatingPhases(of task: MissionTask) -> [MissionPhase] {
        guard task.isPhaseGated else { return [] }
        return (task.blockedByPhases ?? []).compactMap(phase(id:)).sorted { (positions[$0.id] ?? 0) < (positions[$1.id] ?? 0) }
    }

    /// Order key for a phase added after every existing one.
    public var nextOrder: Double { (phases.map(\.order).max() ?? 0) + 1 }

    /// Order updates that move a phase by `offset` positions.
    public func move(_ phaseId: String, by offset: Int) -> [MissionOrderKeys.Key] {
        MissionOrderKeys.move(phaseId, by: offset, in: phases.map { .init(id: $0.id, order: $0.order) })
    }

    public func position(of phaseId: String) -> Int? { positions[phaseId] }
}

/// "Waits for phase Build" or "Waits for phases Build, Polish": why phase gating holds a task. Names that already
/// say "Phase" ("Phase 1") skip the word. Nil when gating does not hold the task.
public enum MissionPhaseGating {
    public static func text(_ phases: [MissionPhase]) -> String? {
        guard !phases.isEmpty else { return nil }
        let names = phases.map(\.name).joined(separator: ", ")
        if phases.allSatisfy({ $0.name.lowercased().hasPrefix("phase") }) { return "Waits for \(names)" }
        return "Waits for \(phases.count == 1 ? "phase" : "phases") \(names)"
    }
}

/// One phase of the Tasks tab, or the tasks without a phase.
public struct MissionPhaseGroup: Identifiable, Equatable, Sendable {
    /// Nil for tasks without a phase, and for the flat list of a mission without phases.
    public let phase: MissionPhase?
    /// Shown tasks: active work, delegated work, done, then dropped when shown, in task order within each status.
    public let tasks: [MissionTask]
    /// Progress of the phase; dropped tasks are excluded, as everywhere else.
    public let counts: MissionTaskCounts
    /// The phase's dropped tasks, shown or not.
    public let dropped: Int
    /// The first phase, in order, with unfinished tasks: where the work is now.
    public let isCurrent: Bool

    public var name: String? { phase?.name }
    public var id: String { Self.id(phase?.id) }
    public var title: String { name ?? "No phase" }
    /// It has tasks and every one is done or dropped, so the phase starts folded.
    public var isFinished: Bool { counts.total + dropped > 0 && counts.done == counts.total }
    /// "12/18 done", "2 dropped" for a phase whose every task was dropped, or "No tasks".
    public var progress: String {
        if counts.total > 0 { return "\(counts.done)/\(counts.total) done" }
        return dropped > 0 ? "\(dropped) dropped" : "No tasks"
    }

    /// The group id of a phase id; nil is "No phase".
    public static func id(_ phaseId: String?) -> String { "phase-" + (phaseId ?? "") }
}

/// The Tasks tab's phases in phase order, then tasks without a phase last under "No phase". A mission without
/// phases is one flat list. Every first-class phase keeps its header, even when empty, so it can be filled or
/// deleted; milestone stand-ins appear only with tasks to show.
public struct MissionTaskPhases: Equatable, Sendable {
    public let groups: [MissionPhaseGroup]
    /// No phase to show, so the list has no phase headers.
    public let isFlat: Bool
    /// Dropped tasks across the mission, shown or not.
    public let dropped: Int
    public let index: MissionPhaseIndex

    /// Within a phase: in progress, in review, blocked and to do, delegated, done, then dropped.
    private static let statusOrder: [MissionTaskStatus: Int] = Dictionary(
        uniqueKeysWithValues: MissionTaskOrdering.groupOrder.enumerated().map { ($1, $0) })

    /// Without `phases`, task milestones stand in for phases.
    public init(_ tasks: [MissionTask], phases: MissionPhaseIndex? = nil, showDropped: Bool) {
        let index = phases ?? MissionPhaseIndex(phases: nil, tasks: tasks)
        let ordered = MissionTaskOrdering.sorted(tasks)
        var byPhase: [String: [MissionTask]] = [:]
        var unphased: [MissionTask] = []
        for task in ordered {
            if let id = index.phaseId(of: task) { byPhase[id, default: []].append(task) } else { unphased.append(task) }
        }
        let rank = Self.statusOrder
        var groups: [MissionPhaseGroup] = []
        var foundCurrent = false
        for phase in index.phases.map(Optional.some) + [nil] {
            let all = phase.map { byPhase[$0.id] ?? [] } ?? unphased
            // A stable sort keeps task order within each status.
            let shown = all.filter { showDropped || $0.workStatus != .dropped }
                .enumerated()
                .sorted { (rank[$0.element.workStatus] ?? 0, $0.offset) < (rank[$1.element.workStatus] ?? 0, $1.offset) }
                .map(\.element)
            let counts = MissionTaskCounts(all)
            let current = !foundCurrent && phase != nil && counts.done < counts.total
            if current { foundCurrent = true }
            guard !shown.isEmpty || (phase != nil && index.isEditable) else { continue }
            groups.append(MissionPhaseGroup(phase: phase, tasks: shown, counts: counts,
                                            dropped: all.count(where: { $0.workStatus == .dropped }), isCurrent: current))
        }
        isFlat = groups.allSatisfy { $0.phase == nil }
        self.groups = groups
        dropped = tasks.count(where: { $0.workStatus == .dropped })
        self.index = index
    }

    /// The group a task appears in, for "Show task".
    public func groupId(of task: MissionTask) -> String { MissionPhaseGroup.id(index.phaseId(of: task)) }

    /// The Overview's progress rows: phases with tasks that count, in order, and "No phase" last. Empty for a
    /// mission without phases, which shows one overall bar instead.
    public var progressRows: [MissionPhaseGroup] { isFlat ? [] : groups.filter { $0.counts.total > 0 } }

    /// The first phase with unfinished tasks.
    public var current: MissionPhaseGroup? { groups.first(where: \.isCurrent) }
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
