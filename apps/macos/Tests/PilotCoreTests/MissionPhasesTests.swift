import Foundation
import Testing
@testable import PilotCore

private func phase(_ id: String, _ order: Double, name: String? = nil) -> MissionPhase {
    MissionPhase(id: id, missionId: "m", name: name ?? id.capitalized, order: order)
}

private func task(_ number: Int, _ status: MissionTaskStatus = .todo, phase: String?, order: Double? = nil,
                  milestone: String? = nil, blockedBy: [String]? = nil) -> MissionTask {
    // Gated tasks arrive as blocked, with their own status in storedStatus.
    MissionTask(id: "t\(number)", number: number, title: "Task \(number)", status: blockedBy == nil ? status : .blocked,
                order: order ?? Double(number), milestone: milestone, phaseId: phase, blockedByPhases: blockedBy,
                storedStatus: blockedBy == nil ? nil : status)
}

@Test func firstClassPhasesFollowTheirOrderNotTaskOrder() {
    let index = MissionPhaseIndex(phases: [phase("release", 3), phase("build", 1), phase("polish", 2)], tasks: [])
    let phases = MissionTaskPhases([
        task(1, phase: "release", milestone: "Old name"), task(2, .done, phase: "build"), task(3, phase: "polish"),
        task(4, phase: nil), task(5, phase: "deleted"),
    ], phases: index, showDropped: false)
    #expect(index.isEditable)
    #expect(phases.groups.map(\.title) == ["Build", "Polish", "Release", "No phase"])
    #expect(phases.groups[3].tasks.map(\.number) == [4, 5], "a task in an unknown phase has no phase")
    #expect(phases.groupId(of: task(1, phase: "release")) == MissionPhaseGroup.id("release"))
    #expect(phases.groupId(of: task(5, phase: "deleted")) == MissionPhaseGroup.id(nil))
    #expect(!phases.isFlat)
}

@Test func emptyPhasesKeepTheirHeaderAndNeverFold() {
    let index = MissionPhaseIndex(phases: [phase("build", 1), phase("later", 2)], tasks: [])
    let phases = MissionTaskPhases([task(1, phase: "build")], phases: index, showDropped: false)
    #expect(phases.groups.map(\.title) == ["Build", "Later"], "no empty No phase group")
    let empty = phases.groups[1]
    #expect(empty.tasks.isEmpty)
    #expect(empty.progress == "No tasks")
    #expect(!empty.isFinished)
    #expect(!MissionPhaseFolds().isFolded(empty))
    #expect(MissionTaskListItem.items(phases, folds: MissionPhaseFolds()).map(\.id)
        == ["phase-build", "t1", "phase-later"])
    // Phases exist but hold no task yet: still headers, not a flat list.
    #expect(!MissionTaskPhases([task(2, phase: nil)], phases: index, showDropped: false).isFlat)
    // No phases at all: one flat list.
    let none = MissionTaskPhases([task(2, phase: nil)], phases: MissionPhaseIndex(phases: [], tasks: []), showDropped: false)
    #expect(none.isFlat)
    #expect(none.progressRows.isEmpty)
}

@Test func theCurrentPhaseIsTheFirstWithUnfinishedTasks() {
    let index = MissionPhaseIndex(phases: [phase("one", 1), phase("empty", 2), phase("two", 3), phase("three", 4)],
                                  tasks: [])
    let tasks = [task(1, .done, phase: "one"), task(2, .dropped, phase: "one"), task(3, .done, phase: "two"),
                 task(4, .inProgress, phase: "two"), task(5, phase: "three"), task(6, phase: nil)]
    let phases = MissionTaskPhases(tasks, phases: index, showDropped: false)
    #expect(phases.groups.map(\.isCurrent) == [false, false, true, false, false])
    #expect(phases.current?.title == "Two")
    #expect(phases.progressRows.map(\.title) == ["One", "Two", "Three", "No phase"], "empty phases have no row")
    #expect(phases.progressRows.map(\.progress) == ["1/1 done", "1/2 done", "0/1 done", "0/1 done"])
    let finished = MissionTaskPhases([task(1, .done, phase: "one"), task(6, phase: nil)], phases: index, showDropped: false)
    #expect(finished.current == nil, "tasks without a phase never make a phase current")
}

@Test func gatedTasksKeepTheirOwnStatusAndNameTheirBlockingPhases() {
    let index = MissionPhaseIndex(phases: [phase("build", 1), phase("polish", 2), phase("release", 3)], tasks: [])
    let gated = task(3, .todo, phase: "release", blockedBy: ["polish", "build", "gone"])
    let started = task(4, .inProgress, phase: "release", blockedBy: ["build"])
    #expect(gated.status == .blocked)
    #expect(gated.isPhaseGated)
    #expect(gated.workStatus == .todo)
    #expect(index.gatingPhases(of: gated).map(\.id) == ["build", "polish"], "phase order, unknown ids skipped")
    #expect(MissionPhaseGating.text(index.gatingPhases(of: gated)) == "Waits for phases Build, Polish")
    #expect(MissionPhaseGating.text(index.gatingPhases(of: started)) == "Waits for phase Build")
    #expect(MissionPhaseGating.text(index.gatingPhases(of: task(5, phase: "build"))) == nil)
    #expect(MissionPhaseGating.text([phase("p1", 1, name: "Phase 1 polish")]) == "Waits for Phase 1 polish")

    let blocked = task(5, .blocked, phase: "build")
    let counts = MissionTaskCounts([gated, started, blocked])
    #expect(counts[.blocked] == 1, "gating is not counted as blocked work")
    #expect(counts[.todo] == 1 && counts[.inProgress] == 1)
    #expect(MissionTaskOrdering.inFlight([gated, started, blocked]).map(\.number) == [4, 5])
    let phases = MissionTaskPhases([gated, started, blocked], phases: index, showDropped: false)
    #expect(phases.groups[2].tasks.map(\.number) == [4, 3], "in progress before to do")

    let mission = Mission(id: "m", projectId: "p", title: "M", goal: "", createdAt: 1, updatedAt: 1)
    let detail = MissionDetail(mission: mission, brief: nil, decisions: [], decisionProposals: nil, comments: [],
                               tasks: [gated, blocked], phases: index.phases, artifacts: [], resources: [], events: [])
    let needs = MissionNeedsYou.items(mission: mission, detail: detail, members: [], isUnread: { _ in false })
    #expect(needs.map(\.id) == ["task-t5"], "gated tasks do not need the user")
}

@Test func legacyMilestonesStandInForPhasesWithoutDaemonPhases() {
    let tasks = [task(1, phase: nil, milestone: "Later"), task(2, phase: nil, order: 0, milestone: "First")]
    let index = MissionPhaseIndex(phases: nil, tasks: tasks)
    #expect(!index.isEditable)
    #expect(index.phases.map(\.name) == ["First", "Later"])
    #expect(index.phaseId(of: tasks[0]) == "Later")
    #expect(MissionTaskPhases(tasks, phases: index, showDropped: false).groups.map(\.title) == ["First", "Later"])
}

@Test func orderKeysPlaceBetweenNeighboursAndRenumberWhenFull() {
    let keys = [MissionOrderKeys.Key(id: "a", order: 1), .init(id: "b", order: 2), .init(id: "c", order: 3)]
    #expect(MissionOrderKeys.place("c", at: 0, in: keys) == [.init(id: "c", order: 0)])
    #expect(MissionOrderKeys.place("a", at: 1, in: keys) == [.init(id: "a", order: 2.5)])
    #expect(MissionOrderKeys.place("a", at: 9, in: keys) == [.init(id: "a", order: 4)])
    #expect(MissionOrderKeys.place("b", at: 1, in: keys).isEmpty, "already there")
    #expect(MissionOrderKeys.move("b", by: -1, in: keys) == [.init(id: "b", order: 0)])
    let tight = [MissionOrderKeys.Key(id: "a", order: 1), .init(id: "b", order: 1), .init(id: "c", order: 1)]
    #expect(MissionOrderKeys.place("c", at: 1, in: tight) == [.init(id: "c", order: 2), .init(id: "b", order: 3)])

    let index = MissionPhaseIndex(phases: [phase("one", 1), phase("two", 2), phase("three", 3)], tasks: [])
    #expect(index.move("three", by: -1) == [.init(id: "three", order: 1.5)])
    #expect(index.move("one", by: -1).isEmpty)
    #expect(index.nextOrder == 4)
    #expect(index.position(of: "two") == 1)
}

@Test func sidebarLineLeadsWithTheCurrentPhase() {
    func mission(_ phase: MissionCurrentPhase?) -> Mission {
        Mission(id: "m", projectId: "p", title: "M", goal: "", createdAt: 1, updatedAt: 1,
                tasksDone: 7, tasksTotal: 20, currentPhase: phase)
    }
    let line = MissionSidebarSummary.line(mission: mission(.init(id: "b", name: "Build", done: 3, total: 8)), working: 2)
    #expect(line?.phase == "Build")
    #expect(line?.detail == "3 of 8 tasks · 2 working")
    #expect(line?.text == "Build · 3 of 8 tasks · 2 working")
    #expect(MissionSidebarSummary.progress(mission: mission(nil), working: 0) == "7 of 20 tasks")
    #expect(MissionSidebarSummary.line(mission: mission(.init(id: "b", name: "Build", done: 0, total: 0)), working: 0)?.text
        == "7 of 20 tasks", "an empty phase is never current")
}

@Test func missionSummariesDecodeTheCurrentPhase() throws {
    let json = """
    {"id":"m","projectId":"p","title":"M","goal":"","status":"active","briefRevision":0,"createdAt":1,"updatedAt":1,
     "phaseGating":true,"currentPhase":{"id":"b","name":"Build","done":3,"total":8}}
    """
    let summary = try JSONDecoder().decode(Mission.self, from: Data(json.utf8))
    #expect(summary.currentPhase == MissionCurrentPhase(id: "b", name: "Build", done: 3, total: 8))
    #expect(summary.isPhaseGatingEnabled)
    let write = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MissionPhaseWrite(name: "Build", order: 2)))
        as? [String: Any]
    #expect(write?["name"] as? String == "Build")
    #expect(write?["order"] as? Double == 2)
    #expect(write?["goal"] == nil)
    let start = try JSONSerialization.jsonObject(with: JSONEncoder().encode(StartMissionTaskRequest(overridePhaseGating: true)))
        as? [String: Any]
    #expect(start?["overridePhaseGating"] as? Bool == true)
}
