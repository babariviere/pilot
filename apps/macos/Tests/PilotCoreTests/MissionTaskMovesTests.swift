import Testing
@testable import PilotCore

private func task(_ number: Int, _ status: MissionTaskStatus = .todo, phase: String? = "p", order: Double? = nil,
                  dependsOn: [String]? = nil) -> MissionTask {
    MissionTask(id: "t\(number)", number: number, title: "Task \(number)", status: status, order: order ?? Double(number),
                dependsOn: dependsOn, phaseId: phase)
}

private let phases = MissionPhaseIndex(phases: [MissionPhase(id: "p", missionId: "m", name: "P", order: 1),
                                                MissionPhase(id: "q", missionId: "m", name: "Q", order: 2)], tasks: [])

@Test func droppingATaskPlacesItBeforeOrAfterTheTargetInItsPhase() {
    let tasks = [task(1), task(2), task(3), task(4, phase: "q", order: 2.5)]
    let before = MissionTaskMove.drop("t3", on: "t1", after: false, tasks: tasks, phases: phases)
    #expect(before?.writes == [.init(taskId: "t3", order: 0)])
    #expect(before?.changesPhase == false)
    let after = MissionTaskMove.drop("t1", on: "t2", after: true, tasks: tasks, phases: phases)
    #expect(after?.writes == [.init(taskId: "t1", order: 2.5)], "between #2 and #3; #4's key is in another phase")
    #expect(MissionTaskMove.drop("t2", on: "t3", after: false, tasks: tasks, phases: phases) == nil, "already there")
    #expect(MissionTaskMove.drop("t2", on: "t2", after: false, tasks: tasks, phases: phases) == nil)
    #expect(MissionTaskMove.drop("t2", on: "gone", after: false, tasks: tasks, phases: phases) == nil)
}

@Test func droppingIntoAnotherPhaseMovesAndPlacesTheTask() {
    let tasks = [task(1), task(2, phase: "q", order: 10), task(3, phase: "q", order: 11), task(4, phase: nil, order: 0)]
    let move = MissionTaskMove.drop("t1", on: "t3", after: true, tasks: tasks, phases: phases)
    #expect(move?.writes == [.init(taskId: "t1", order: 12, phase: .set("q"))])
    #expect(move?.phaseId == "q")
    #expect(move?.changesPhase == true)
    let top = MissionTaskMove.dropAtTop("t3", of: nil, tasks: tasks, phases: phases)
    #expect(top?.writes == [.init(taskId: "t3", order: -1, phase: .clear)])
    // Dropping on a phase header where the task already leads changes nothing.
    #expect(MissionTaskMove.dropAtTop("t2", of: "q", tasks: tasks, phases: phases) == nil)
    // An empty phase takes the task with its key unchanged.
    let empty = MissionPhaseIndex(phases: phases.phases + [MissionPhase(id: "r", missionId: "m", name: "R", order: 3)], tasks: [])
    #expect(MissionTaskMove.dropAtTop("t1", of: "r", tasks: tasks, phases: empty)?.writes == [.init(taskId: "t1", phase: .set("r"))])
}

@Test func droppingRenumbersThePhaseWhenKeysLeaveNoRoom() {
    let tasks = [task(1, order: 1), task(2, order: 1), task(3, order: 1)]
    let move = MissionTaskMove.drop("t3", on: "t2", after: false, tasks: tasks, phases: phases)
    #expect(move?.writes == [.init(taskId: "t3", order: 2), .init(taskId: "t2", order: 3)])
    #expect(move?.writes.first?.request.order == 2)
}

@Test func milestoneStandInsReorderButNeverMoveTasksBetweenPhases() {
    let legacy = [MissionTask(id: "a", number: 1, title: "A", order: 1, milestone: "One"),
                  MissionTask(id: "b", number: 2, title: "B", order: 2, milestone: "One"),
                  MissionTask(id: "c", number: 3, title: "C", order: 3, milestone: "Two")]
    let index = MissionPhaseIndex(phases: nil, tasks: legacy)
    #expect(MissionTaskMove.drop("b", on: "a", after: false, tasks: legacy, phases: index)?.writes == [.init(taskId: "b", order: 0)])
    #expect(MissionTaskMove.drop("a", on: "c", after: false, tasks: legacy, phases: index) == nil)
}

@Test func dependencyChoicesExcludeCyclesAndListOpenWorkFirst() {
    let tasks = [task(1, dependsOn: ["t2"]), task(2), task(3, .done), task(4, dependsOn: ["t1"]), task(5, dependsOn: ["t4", "t4"]),
                 task(6)]
    #expect(MissionDependencyChoices.excluded(for: tasks[1], in: tasks) == ["t2", "t1", "t4", "t5"],
            "#2 cannot wait on what already waits on it")
    #expect(MissionDependencyChoices.excluded(for: tasks[5], in: tasks) == ["t6"])
    #expect(MissionDependencyChoices.candidates(for: tasks[1], in: tasks).map(\.number) == [1, 4, 5, 6, 3])
    #expect(MissionDependencyChoices.candidates(for: tasks[1], in: tasks, query: "#4").map(\.number) == [4])
    #expect(MissionDependencyChoices.candidates(for: tasks[1], in: tasks, query: " task 6").map(\.number) == [6])
    #expect(MissionDependencyChoices.selection(["t6", "gone", "t3"], in: tasks) == ["t3", "t6"])
}

