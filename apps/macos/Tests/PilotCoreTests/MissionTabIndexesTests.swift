import Testing
@testable import PilotCore

private func task(_ number: Int, _ status: MissionTaskStatus = .todo, chat: String? = nil) -> MissionTask {
    MissionTask(id: "t\(number)", number: number, title: "Task \(number)", status: status, order: Double(number),
                sessionId: chat)
}

private func task(_ number: Int, _ status: MissionTaskStatus = .todo, phase: String?, order: Double) -> MissionTask {
    MissionTask(id: "t\(number)", number: number, title: "Task \(number)", status: status, order: order, milestone: phase)
}

private func resource(_ id: String, task: String?) -> MissionResource {
    MissionResource(id: id, taskId: task, pullRequest: nil, url: "https://example.com/\(id)", title: nil, kind: .url,
                    externalId: nil, addedBySessionId: nil, createdAt: 0)
}

private func artifact(_ id: String, task: String?) -> MissionArtifactLink {
    MissionArtifactLink(taskId: task, artifactId: id, sessionId: "chat", title: id, kind: "html", revision: nil,
                        linkedBySessionId: nil, linkedAt: 0)
}

@Test func taskLinkIndexGroupsLinksByTaskInSavedOrder() {
    let index = MissionTaskLinkIndex(
        resources: [resource("a", task: "t1"), resource("mission", task: nil), resource("b", task: "t2"), resource("c", task: "t1")],
        artifacts: [artifact("x", task: "t2"), artifact("y", task: nil)])
    #expect(index.resources(of: "t1").map(\.id) == ["a", "c"])
    #expect(index.resources(of: "t2").map(\.id) == ["b"])
    #expect(index.resources(of: "t3").isEmpty)
    #expect(index.artifacts(of: "t2").map(\.artifactId) == ["x"])
    #expect(index.artifacts(of: "t1").isEmpty)
}

@Test func phasesFollowFirstAppearanceWithNoPhaseLast() {
    let phases = MissionTaskPhases([
        task(1, phase: nil, order: 1), task(2, phase: "Endpoints", order: 2), task(3, phase: "Foundations", order: 3),
        task(4, phase: "Endpoints", order: 4), task(5, phase: "  ", order: 5), task(6, phase: "Foundations", order: 0),
    ], showDropped: false)
    #expect(!phases.isFlat)
    #expect(phases.groups.map(\.name) == ["Foundations", "Endpoints", nil], "task order decides, blank is no phase")
    #expect(phases.groups.map(\.title) == ["Foundations", "Endpoints", "No phase"])
    #expect(phases.groups[2].tasks.map(\.number) == [1, 5])
    #expect(phases.groupId(of: task(5, phase: " ", order: 5)) == phases.groups[2].id)
    #expect(phases.groupId(of: task(2, phase: "Endpoints", order: 2)) == phases.groups[1].id)
    #expect(!phases.index.isEditable, "milestone stand-ins cannot be edited")
}

@Test func phasesListActiveWorkThenDoneInTaskOrder() {
    let phases = MissionTaskPhases([
        task(1, .done, phase: "P", order: 1), task(2, .todo, phase: "P", order: 2), task(3, .blocked, phase: "P", order: 3),
        task(4, .inReview, phase: "P", order: 4), task(5, .inProgress, phase: "P", order: 5),
        task(6, .todo, phase: "P", order: 6), task(7, .done, phase: "P", order: 7), task(8, .dropped, phase: "P", order: 8),
    ], showDropped: false)
    let group = phases.groups[0]
    #expect(group.tasks.map(\.number) == [5, 4, 3, 2, 6, 1, 7])
    #expect(group.counts.done == 2 && group.counts.total == 7)
    #expect(group.progress == "2/7 done")
    #expect(!group.isFinished)
}

@Test func missionsWithoutMilestonesAreOneFlatList() {
    let phases = MissionTaskPhases([task(1, .done), task(2), task(3, .inProgress), task(4, .dropped)], showDropped: false)
    #expect(phases.isFlat)
    #expect(phases.groups.count == 1)
    #expect(phases.groups[0].tasks.map(\.number) == [3, 2, 1])
    var folds = MissionPhaseFolds()
    folds.toggle(phases.groups[0])
    let items = MissionTaskListItem.items(phases, folds: folds)
    #expect(items.map(\.id) == ["t3", "t2", "t1"], "a flat list has no header and never folds")
    #expect(MissionTaskPhases([], showDropped: false).groups.isEmpty)
}

@Test func droppedTasksStayHiddenUntilShown() {
    let tasks = [task(1, .done, phase: "A", order: 1), task(2, .dropped, phase: "A", order: 2),
                 task(3, .todo, phase: "A", order: 3), task(4, .dropped, phase: "Gone", order: 4),
                 task(5, .dropped, phase: nil, order: 5)]
    let hidden = MissionTaskPhases(tasks, showDropped: false)
    #expect(hidden.dropped == 3)
    #expect(hidden.groups.map(\.name) == ["A"], "phases with only dropped tasks disappear while hidden")
    #expect(hidden.groups[0].tasks.map(\.number) == [3, 1])
    #expect(hidden.groups[0].dropped == 1)
    let shown = MissionTaskPhases(tasks, showDropped: true)
    #expect(shown.groups.map(\.name) == ["A", "Gone", nil])
    #expect(shown.groups[0].tasks.map(\.number) == [3, 1, 2], "dropped tasks come last in their phase")
    #expect(shown.groups[1].progress == "1 dropped")
    #expect(shown.groups[1].isFinished)
    // Only dropped tasks name a milestone: hidden, the rest is one flat list.
    let onlyDropped = [task(1, phase: nil, order: 1), task(2, .dropped, phase: "Old", order: 2)]
    #expect(MissionTaskPhases(onlyDropped, showDropped: false).isFlat)
    #expect(!MissionTaskPhases(onlyDropped, showDropped: true).isFlat)
}

@Test func finishedPhasesStartFoldedAndChoicesHoldAcrossRefreshes() {
    func phases(_ status: MissionTaskStatus) -> MissionTaskPhases {
        MissionTaskPhases([task(1, .done, phase: "Done", order: 1), task(2, .dropped, phase: "Done", order: 2),
                           task(3, status, phase: "Open", order: 3), task(4, .inProgress, phase: nil, order: 4)],
                          showDropped: false)
    }
    var folds = MissionPhaseFolds()
    let first = phases(.todo)
    #expect(first.groups.map { folds.isFolded($0) } == [true, false, false])
    #expect(MissionTaskListItem.items(first, folds: folds).map(\.id) == ["phase-Done", "phase-Open", "t3", "phase-", "t4"])

    folds.toggle(first.groups[0])
    folds.toggle(first.groups[1])
    // A refresh that finishes the open phase keeps both choices.
    let refreshed = phases(.done)
    #expect(refreshed.groups.map { folds.isFolded($0) } == [false, true, false])
    #expect(MissionTaskListItem.items(refreshed, folds: folds).map(\.id) == ["phase-Done", "t1", "phase-Open", "phase-", "t4"])

    // "Show task" opens a phase by a task's id.
    folds.unfold(refreshed.groupId(of: task(3, phase: "Open", order: 3)))
    #expect(!folds.isFolded(refreshed.groups[1]))
}

@Test func taskRowsReorderWithinTheirStatusInThePhase() {
    let phases = MissionTaskPhases([task(1, .todo, phase: "P", order: 1), task(2, .done, phase: "P", order: 2),
                                    task(3, .todo, phase: "P", order: 3), task(4, .todo, phase: "Q", order: 4)],
                                   showDropped: false)
    let items = MissionTaskListItem.items(phases, folds: MissionPhaseFolds())
    #expect(items.map(\.id) == ["phase-P", "t1", "t3", "t2", "phase-Q", "t4"])
    guard case let .task(third, index, siblings) = items[2], case let .task(_, _, doneSiblings) = items[3] else {
        Issue.record("Expected task rows")
        return
    }
    #expect(third.number == 3)
    #expect(index == 1)
    #expect(siblings.map(\.number) == [1, 3])
    #expect(doneSiblings.map(\.number) == [2])
}

@Test func tasksByChatKeepsTaskOrder() {
    let index = MissionTasksByChat.index([task(3, chat: "a"), task(1, chat: "b"), task(2, chat: "a"), task(4)])
    #expect(index["a"]?.map(\.number) == [3, 2])
    #expect(index["b"]?.map(\.number) == [1])
    #expect(index.count == 2)
}
