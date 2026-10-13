import Foundation

/// A task named by number, with its title for tooltips.
public struct MissionTaskReference: Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let number: Int
    public let title: String

    public init(_ task: MissionTask) {
        id = task.id
        number = task.number
        title = task.title
    }
}

/// How one task relates to the others: what it still waits on, what it came after, what needs it.
public struct MissionTaskDependencies: Equatable, Sendable {
    /// Known dependencies that are not done or dropped, by number. Empty for a closed task.
    public let waitingOn: [MissionTaskReference]
    /// Known dependencies the task no longer waits on, by number.
    public let after: [MissionTaskReference]
    /// Tasks that list this one as a dependency, by number.
    public let neededBy: [MissionTaskReference]

    public static let none = MissionTaskDependencies(waitingOn: [], after: [], neededBy: [])

    public var isWaiting: Bool { !waitingOn.isEmpty }

    /// "#12, #14".
    static func numbers(_ tasks: [MissionTaskReference]) -> String {
        tasks.map { "#\($0.number)" }.joined(separator: ", ")
    }

    /// Caption text for the visible line, e.g. "Waiting on #12, #14". Nil when nothing is unfinished.
    public var waitingText: String? { isWaiting ? "Waiting on \(Self.numbers(waitingOn))" : nil }

    /// Tooltip lines: what the task waits on, what it came after, what needs it. Nil when there is nothing to say.
    public var helpText: String? {
        var lines: [String] = []
        if let waitingText { lines.append(waitingText) }
        if !after.isEmpty { lines.append("After \(Self.numbers(after))") }
        if !neededBy.isEmpty { lines.append("Needed by \(Self.numbers(neededBy))") }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// "Needed by #20, #21" for menus. Nil when no task depends on this one.
    public var neededByText: String? { neededBy.isEmpty ? nil : "Needed by \(Self.numbers(neededBy))" }

    /// Spoken form: "waiting on task 12 and task 14". Nil when the task is not waiting.
    public var accessibilityText: String? {
        guard isWaiting else { return nil }
        let names = waitingOn.map { "task \($0.number)" }
        let joined = names.count > 1
            ? names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
            : names[0]
        return "waiting on \(joined)"
    }
}

/// One id to task dictionary and one dependents index for a mission's tasks, built once per detail
/// update so rows never filter the whole list.
public struct MissionTaskDependencyIndex: Sendable {
    private let tasksById: [String: MissionTask]
    private let dependents: [String: [MissionTaskReference]]

    public static let empty = MissionTaskDependencyIndex(tasks: [])

    public init(tasks: [MissionTask]) {
        var byId = [String: MissionTask](minimumCapacity: tasks.count)
        for task in tasks { byId[task.id] = task }
        var reverse: [String: [MissionTaskReference]] = [:]
        for task in tasks {
            for dependency in Set(task.dependsOn ?? []) where byId[dependency] != nil && dependency != task.id {
                reverse[dependency, default: []].append(MissionTaskReference(task))
            }
        }
        tasksById = byId
        dependents = reverse.mapValues { $0.sorted { $0.number < $1.number } }
    }

    public func task(id: String) -> MissionTask? { tasksById[id] }

    /// Dependencies are looked up by id. Unknown ids (deleted tasks) and self references are skipped.
    public func dependencies(of task: MissionTask) -> MissionTaskDependencies {
        let known = Set(task.dependsOn ?? []).compactMap { id in id == task.id ? nil : tasksById[id] }
            .sorted { $0.number < $1.number }
        let closed = task.status.isClosed
        return MissionTaskDependencies(
            waitingOn: closed ? [] : known.filter { !$0.status.isClosed }.map(MissionTaskReference.init),
            after: known.filter { closed || $0.status.isClosed }.map(MissionTaskReference.init),
            neededBy: dependents[task.id] ?? [])
    }
}
