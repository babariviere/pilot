/// Lookups the mission tabs build once per detail change, so rows never search the mission's lists.

/// Task links and artifacts by task id, in their saved order.
public struct MissionTaskLinkIndex: Sendable {
    private let resourcesByTask: [String: [MissionResource]]
    private let artifactsByTask: [String: [MissionArtifactLink]]

    public static let empty = MissionTaskLinkIndex(resources: [], artifacts: [])

    public init(resources: [MissionResource], artifacts: [MissionArtifactLink]) {
        var resourcesByTask: [String: [MissionResource]] = [:]
        for resource in resources {
            if let taskId = resource.taskId { resourcesByTask[taskId, default: []].append(resource) }
        }
        var artifactsByTask: [String: [MissionArtifactLink]] = [:]
        for artifact in artifacts {
            if let taskId = artifact.taskId { artifactsByTask[taskId, default: []].append(artifact) }
        }
        self.resourcesByTask = resourcesByTask
        self.artifactsByTask = artifactsByTask
    }

    public init(_ detail: MissionDetail) {
        self.init(resources: detail.resources, artifacts: detail.artifacts)
    }

    public func resources(of taskId: String) -> [MissionResource] { resourcesByTask[taskId] ?? [] }
    public func artifacts(of taskId: String) -> [MissionArtifactLink] { artifactsByTask[taskId] ?? [] }
}

/// One line of the Tasks tab: a phase header or a task in an unfolded phase. A flat list lets a lazy stack
/// create only the rows on screen.
public enum MissionTaskListItem: Identifiable, Equatable, Sendable {
    case header(MissionPhaseGroup, folded: Bool)
    /// `index` is the task's position in its phase. `siblings` are the phase's tasks with the same status, the
    /// list Move Up and Move Down reorder within.
    case task(MissionTask, index: Int, siblings: [MissionTask])

    public var id: String {
        switch self {
        case let .header(group, _): group.id
        case let .task(task, _, _): task.id
        }
    }

    /// A flat list has no headers and never folds.
    public static func items(_ phases: MissionTaskPhases, folds: MissionPhaseFolds) -> [MissionTaskListItem] {
        var items: [MissionTaskListItem] = []
        items.reserveCapacity(phases.groups.reduce(phases.groups.count) { $0 + $1.tasks.count })
        for group in phases.groups {
            if !phases.isFlat {
                let folded = folds.isFolded(group)
                items.append(.header(group, folded: folded))
                if folded { continue }
            }
            var byStatus: [MissionTaskStatus: [MissionTask]] = [:]
            for task in group.tasks { byStatus[task.workStatus, default: []].append(task) }
            for (index, task) in group.tasks.enumerated() {
                items.append(.task(task, index: index, siblings: byStatus[task.workStatus] ?? []))
            }
        }
        return items
    }
}

/// Chats' tasks by owning chat id, in task order.
public enum MissionTasksByChat {
    public static func index(_ tasks: [MissionTask]) -> [String: [MissionTask]] {
        var result: [String: [MissionTask]] = [:]
        for task in tasks {
            if let sessionId = task.sessionId { result[sessionId, default: []].append(task) }
        }
        return result
    }
}
