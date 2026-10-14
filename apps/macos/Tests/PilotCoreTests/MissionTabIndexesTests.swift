import Testing
@testable import PilotCore

private func task(_ number: Int, _ status: MissionTaskStatus = .todo, chat: String? = nil) -> MissionTask {
    MissionTask(id: "t\(number)", number: number, title: "Task \(number)", status: status, order: Double(number),
                sessionId: chat)
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

@Test func taskListItemsSkipRowsOfFoldedGroups() {
    let groups = MissionTaskOrdering.groups([task(1, .done), task(2), task(3, .inProgress), task(4)])
    let items = MissionTaskListItem.items(groups, collapsed: [.done])
    #expect(items.map(\.id) == ["group-in_progress", "t3", "group-todo", "t2", "t4", "group-done"])
    guard case let .task(second, index, group) = items[4] else {
        Issue.record("Expected a task row")
        return
    }
    #expect(second.number == 4)
    #expect(index == 1)
    #expect(group.tasks.map(\.number) == [2, 4])
}

@Test func tasksByChatKeepsTaskOrder() {
    let index = MissionTasksByChat.index([task(3, chat: "a"), task(1, chat: "b"), task(2, chat: "a"), task(4)])
    #expect(index["a"]?.map(\.number) == [3, 2])
    #expect(index["b"]?.map(\.number) == [1])
    #expect(index.count == 2)
}
