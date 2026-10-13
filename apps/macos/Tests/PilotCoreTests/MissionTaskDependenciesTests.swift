import Testing
@testable import PilotCore

private func task(_ number: Int, _ status: MissionTaskStatus = .todo, dependsOn: [String]? = nil) -> MissionTask {
    MissionTask(id: "t\(number)", number: number, title: "Task \(number)", status: status, dependsOn: dependsOn)
}

@Test func unfinishedDependenciesAreListedByNumber() {
    let tasks = [task(14), task(12, .inProgress), task(20, dependsOn: ["t14", "t12"])]
    let info = MissionTaskDependencyIndex(tasks: tasks).dependencies(of: tasks[2])
    #expect(info.waitingOn.map(\.number) == [12, 14])
    #expect(info.isWaiting)
    #expect(info.waitingText == "Waiting on #12, #14")
    #expect(info.accessibilityText == "waiting on task 12 and task 14")
}

@Test func finishedAndDroppedDependenciesAreHidden() {
    let tasks = [task(12, .done), task(13, .dropped), task(14, .inReview), task(20, dependsOn: ["t12", "t13", "t14"])]
    let info = MissionTaskDependencyIndex(tasks: tasks).dependencies(of: tasks[3])
    #expect(info.waitingOn.map(\.number) == [14])
    #expect(info.after.map(\.number) == [12, 13])
    #expect(info.waitingText == "Waiting on #14")
    #expect(info.helpText == "Waiting on #14\nAfter #12, #13")
}

@Test func allDependenciesFinishedShowsNothingButTooltip() {
    let tasks = [task(12, .done), task(20, dependsOn: ["t12"])]
    let info = MissionTaskDependencyIndex(tasks: tasks).dependencies(of: tasks[1])
    #expect(!info.isWaiting)
    #expect(info.waitingText == nil)
    #expect(info.accessibilityText == nil)
    #expect(info.helpText == "After #12")
}

@Test func unknownAndSelfDependenciesAreSkipped() {
    let tasks = [task(5, dependsOn: ["gone", "t5", "gone"])]
    let info = MissionTaskDependencyIndex(tasks: tasks).dependencies(of: tasks[0])
    #expect(info == .none)
    #expect(info.helpText == nil)
}

@Test func duplicateDependenciesCountOnce() {
    let tasks = [task(1), task(2, dependsOn: ["t1", "t1"])]
    let index = MissionTaskDependencyIndex(tasks: tasks)
    #expect(index.dependencies(of: tasks[1]).waitingOn.count == 1)
    #expect(index.dependencies(of: tasks[0]).neededBy.map(\.number) == [2])
}

@Test func closedTasksAreNotWaiting() {
    let tasks = [task(1), task(2, .done, dependsOn: ["t1"])]
    let info = MissionTaskDependencyIndex(tasks: tasks).dependencies(of: tasks[1])
    #expect(!info.isWaiting)
    #expect(info.waitingOn.isEmpty)
}

@Test func dependentsIndexIsReverseDirectionSortedByNumber() {
    let tasks = [task(21, dependsOn: ["t12"]), task(20, dependsOn: ["t12", "t14"]), task(12), task(14), task(30, dependsOn: ["gone"])]
    let index = MissionTaskDependencyIndex(tasks: tasks)
    #expect(index.dependencies(of: tasks[2]).neededBy.map(\.number) == [20, 21])
    #expect(index.dependencies(of: tasks[2]).neededByText == "Needed by #20, #21")
    #expect(index.dependencies(of: tasks[3]).neededBy.map(\.number) == [20])
    #expect(index.dependencies(of: tasks[0]).neededByText == nil)
    #expect(index.task(id: "t14")?.number == 14)
}

@Test func accessibilityTextJoinsThreeOrMore() {
    let tasks = [task(1), task(2), task(3), task(9, dependsOn: ["t1", "t2", "t3"])]
    let info = MissionTaskDependencyIndex(tasks: tasks).dependencies(of: tasks[3])
    #expect(info.accessibilityText == "waiting on task 1, task 2 and task 3")
}
