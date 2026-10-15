import Foundation
import Testing
@testable import PilotCore

@Test func delegatedTasksDecodeRoundTripAndHaveQuietLabels() throws {
    let data = Data(#"{"id":"t","number":1,"title":"SDK","status":"delegated","delegatedTo":"Alex Chen","order":1,"createdAt":1,"updatedAt":1}"#.utf8)
    let task = try JSONDecoder().decode(MissionTask.self, from: data)
    #expect(task.status == .delegated)
    #expect(task.delegatedTo == "Alex Chen")
    #expect(task.delegationLabel == "Delegated to Alex Chen")
    #expect(try JSONDecoder().decode(MissionTask.self, from: JSONEncoder().encode(task)) == task)
    let manual = MissionTask(id: "manual", number: 2, title: "Translate", status: .delegated)
    #expect(manual.delegationLabel == "Delegated")
    let blank = MissionTask(id: "blank", number: 3, title: "Translate", status: .delegated, delegatedTo: "  ")
    #expect(blank.delegationLabel == "Delegated")
    let stale = MissionTask(id: "stale", number: 4, title: "Returned", status: .todo, delegatedTo: "Alex")
    #expect(stale.delegationLabel == nil)
    let legacy = try JSONDecoder().decode(MissionTask.self, from: Data(
        #"{"id":"old","number":5,"title":"Existing","status":"todo","order":5,"createdAt":1,"updatedAt":1}"#.utf8))
    #expect(legacy.delegatedTo == nil)
    #expect(MissionTaskStatus.allCases.contains(.delegated))
    let write = try JSONEncoder().encode(MissionTaskWrite(status: .delegated))
    #expect(String(decoding: write, as: UTF8.self).contains(#""status":"delegated""#))
}

@Test func delegatedStatusIsOpenButCannotStart() {
    #expect(!MissionTaskStatus.delegated.isClosed)
    #expect(!MissionTaskStatus.delegated.canStart)
    for status in [MissionTaskStatus.todo, .inProgress, .blocked, .inReview] {
        #expect(status.canStart)
    }
    #expect(!MissionTaskStatus.done.canStart)
    #expect(!MissionTaskStatus.dropped.canStart)
}

@Test func delegationSortsAfterTodoAndBlockedBeforeDoneWithinItsPhase() {
    let tasks = [
        MissionTask(id: "done", number: 1, title: "Done", status: .done, order: 1, milestone: "Release"),
        MissionTask(id: "second", number: 2, title: "Second handoff", status: .delegated, order: 4, milestone: "Release"),
        MissionTask(id: "todo", number: 3, title: "Todo", status: .todo, order: 3, milestone: "Release"),
        MissionTask(id: "first", number: 4, title: "First handoff", status: .delegated, order: 2, milestone: "Release"),
        MissionTask(id: "blocked", number: 5, title: "Blocked", status: .blocked, order: 5, milestone: "Release"),
        MissionTask(id: "dropped", number: 6, title: "Dropped", status: .dropped, order: 6, milestone: "Release"),
    ]
    let phases = MissionTaskPhases(tasks, showDropped: true)
    #expect(phases.groups[0].tasks.map(\.id) == ["blocked", "todo", "first", "second", "done", "dropped"])
    #expect(MissionTaskOrdering.groups(tasks).map(\.status) == [.blocked, .todo, .delegated, .done, .dropped])
    let items = MissionTaskListItem.items(phases, folds: MissionPhaseFolds())
    #expect(items.map(\.id) == ["phase-Release", "blocked", "todo", "first", "second", "done", "dropped"])
    guard case let .task(_, _, siblings) = items[3] else {
        Issue.record("Expected delegated task")
        return
    }
    #expect(siblings.map(\.id) == ["first", "second"])
}

@Test func delegatedWorkIsIncludedInProgressAndKeepsOtherwiseFinishedPhasesOpen() {
    let tasks = [
        MissionTask(id: "done", number: 1, title: "Done", status: .done, milestone: "Documentation"),
        MissionTask(id: "dropped", number: 2, title: "Dropped", status: .dropped, milestone: "Documentation"),
        MissionTask(id: "delegated", number: 3, title: "Delegated", status: .delegated, milestone: "Documentation"),
    ]
    for showDropped in [false, true] {
        let phases = MissionTaskPhases(tasks, showDropped: showDropped)
        let group = phases.groups[0]
        #expect(group.counts.done == 1)
        #expect(group.counts.total == 2)
        #expect(group.counts[.delegated] == 1)
        #expect(group.progress == "1/2 done")
        #expect(!group.isFinished)
        #expect(!MissionPhaseFolds().isFolded(group))
    }
    let counts = MissionTaskCounts(tasks)
    #expect(counts.done == 1 && counts.total == 2)
    #expect(MissionTaskCounts.barOrder.reduce(0) { $0 + counts[$1] } == counts.total)
    let progress = MissionMilestones.progress(tasks)[0].counts
    #expect(progress.done == 1 && progress.total == 2)
    let onlyDelegated = MissionTaskPhases([tasks[2]], showDropped: false).groups[0]
    #expect(!onlyDelegated.isFinished)
    #expect(onlyDelegated.progress == "0/1 done")
}

@Test func delegatedDependenciesStillWait() {
    let delegated = MissionTask(id: "sdk", number: 1, title: "SDK", status: .delegated)
    let dependent = MissionTask(id: "publish", number: 2, title: "Publish", dependsOn: ["sdk"])
    let info = MissionTaskDependencyIndex(tasks: [delegated, dependent]).dependencies(of: dependent)
    #expect(info.isWaiting)
    #expect(info.waitingOn.map(\.id) == ["sdk"])
    #expect(info.waitingText == "Waiting on #1")
}
