import Foundation

/// The writes of one drag in the Tasks tab: the dragged task's new order key, its new phase when the drop crosses
/// phases, and any renumbering of the phase's other tasks when neighbouring keys leave no room.
public struct MissionTaskMove: Equatable, Sendable {
    public enum PhaseChange: Equatable, Sendable {
        case set(String)
        case clear
    }

    public struct Write: Equatable, Sendable {
        public let taskId: String
        public let order: Double?
        public let phase: PhaseChange?

        public init(taskId: String, order: Double? = nil, phase: PhaseChange? = nil) {
            self.taskId = taskId
            self.order = order
            self.phase = phase
        }

        /// The PATCH body for this write.
        public var request: MissionTaskWrite {
            MissionTaskWrite(order: order, phaseId: phase.map { change in
                switch change {
                case let .set(id): .set(id)
                case .clear: .clear
                }
            })
        }
    }

    /// The dragged task first, then other tasks the move renumbers.
    public let writes: [Write]
    /// The phase the task ends up in; nil is no phase.
    public let phaseId: String?
    /// The drop moves the task into another phase.
    public let changesPhase: Bool

    /// Places `taskId` before `targetId` (or after it), in the target's phase. Within a phase, tasks keep their
    /// status order, so the order key places the task among the phase's tasks of every status. Nil when nothing
    /// changes, or when the move would change phase without first-class phases to move it between.
    public static func drop(_ taskId: String, on targetId: String, after: Bool, tasks: [MissionTask],
                            phases: MissionPhaseIndex) -> MissionTaskMove? {
        guard taskId != targetId, let target = tasks.first(where: { $0.id == targetId }) else { return nil }
        return place(taskId, in: phases.phaseId(of: target), tasks: tasks, phases: phases) { others in
            others.firstIndex { $0.id == targetId }.map { $0 + (after ? 1 : 0) }
        }
    }

    /// Places `taskId` first in a phase (nil: no phase), for a drop on the phase's header.
    public static func dropAtTop(_ taskId: String, of phaseId: String?, tasks: [MissionTask],
                                 phases: MissionPhaseIndex) -> MissionTaskMove? {
        place(taskId, in: phaseId, tasks: tasks, phases: phases) { _ in 0 }
    }

    private static func place(_ taskId: String, in phaseId: String?, tasks: [MissionTask], phases: MissionPhaseIndex,
                              destination: ([MissionTask]) -> Int?) -> MissionTaskMove? {
        guard let task = tasks.first(where: { $0.id == taskId }) else { return nil }
        let changesPhase = phases.phaseId(of: task) != phaseId
        // Milestone stand-ins from an older daemon cannot take tasks.
        if changesPhase, !phases.isEditable { return nil }
        let others = MissionTaskOrdering.sorted(tasks.filter { $0.id != taskId && phases.phaseId(of: $0) == phaseId })
        guard let index = destination(others) else { return nil }
        // The dragged task sits at its own key's position, so a move into another phase still lands where it is dropped.
        let keys = MissionTaskOrdering.sorted(others + [task]).map { MissionOrderKeys.Key(id: $0.id, order: $0.order) }
        let orders = MissionOrderKeys.place(taskId, at: index, in: keys)
        guard changesPhase || !orders.isEmpty else { return nil }
        let phase: PhaseChange? = changesPhase ? (phaseId.map { .set($0) } ?? .clear) : nil
        let own = Write(taskId: taskId, order: orders.first { $0.id == taskId }?.order, phase: phase)
        let rest = orders.filter { $0.id != taskId }.map { Write(taskId: $0.id, order: $0.order) }
        return MissionTaskMove(writes: (own.order != nil || own.phase != nil ? [own] : []) + rest, phaseId: phaseId,
                               changesPhase: changesPhase)
    }
}

/// Which tasks a task may wait on in the dependency editor.
public enum MissionDependencyChoices {
    /// Tasks that cannot become dependencies of `task`: itself and every task that already waits on it, directly or
    /// through others, since either would make a cycle.
    public static func excluded(for task: MissionTask, in tasks: [MissionTask]) -> Set<String> {
        var dependents: [String: [String]] = [:]
        for other in tasks {
            for dependency in Set(other.dependsOn ?? []) { dependents[dependency, default: []].append(other.id) }
        }
        var excluded: Set<String> = [task.id]
        var queue = [task.id]
        while let next = queue.popLast() {
            for dependent in dependents[next] ?? [] where excluded.insert(dependent).inserted { queue.append(dependent) }
        }
        return excluded
    }

    /// Candidates in task order, open work before closed work, matching `query` by number ("12", "#12") or title.
    public static func candidates(for task: MissionTask, in tasks: [MissionTask], query: String = "") -> [MissionTask] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let number = Int(text.hasPrefix("#") ? String(text.dropFirst()) : text)
        let matching = MissionTaskOrdering.sorted(tasks).filter { other in
            guard other.id != task.id else { return false }
            guard !text.isEmpty else { return true }
            return other.number == number || other.title.lowercased().contains(text)
        }
        return matching.filter { !$0.workStatus.isClosed } + matching.filter { $0.workStatus.isClosed }
    }

    /// The dependency ids to save, in task-number order, keeping only tasks that still exist.
    public static func selection(_ ids: Set<String>, in tasks: [MissionTask]) -> [String] {
        tasks.filter { ids.contains($0.id) }.sorted { $0.number < $1.number }.map(\.id)
    }
}

