import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func taskRequestsRunOnceEvenWhenARowAppearsLater() {
    let requests = MissionTaskRequests()
    requests.send(.editTitle, to: "a")
    #expect(requests.take(requests.latest, for: "b") == nil, "another row ignores it")
    #expect(requests.take(requests.latest, for: "a") == .editTitle)
    #expect(requests.take(requests.latest, for: "a") == nil, "a row realized later does not replay it")
    requests.send(.editTitle, to: "a")
    #expect(requests.take(requests.latest, for: "a") == .editTitle, "a new request runs again")
}

@Test @MainActor func highlightedTaskActionsNeedNoHover() throws {
    let model = AppModel(projectFolderDefaults: UserDefaults(suiteName: "mission-keys-\(UUID())")!)
    let fixture = MissionTabsFixture(taskCount: 4, briefBytes: 10, eventCount: 0)
    model.client.loadFixture(projects: [fixture.project], sessions: fixture.sessions)
    model.client.loadMissionFixture([fixture.detail])
    let missionId = fixture.detail.mission.id
    let task = try #require(fixture.detail.tasks.first { $0.sessionId == nil })
    model.keyboardTarget = .missionTask(missionId: missionId, taskId: task.id)
    let catalog = CommandPaletteCatalog(model: model, openSettings: {}, openKeyboardShortcuts: {})
    let target = try #require(catalog.targetActions())
    #expect(target.title == "Highlighted: #\(task.number) \(task.title)")
    let titles = target.entries.map(\.item.title)
    for expected in ["Edit title", "Move up", "Move down", "Copy reference"] { #expect(titles.contains(expected)) }
    #expect(!titles.contains("Status: \(task.workStatus.label)"), "the current status is not offered")
    #expect(titles.contains { $0.hasPrefix("Status: ") })
    #expect(!titles.contains("Delete task"), "deleting stays in the row's context menu")
    try #require(target.entries.first { $0.item.title == "Edit title" }).perform()
    #expect(model.missionTaskRequests.latest?.taskId == task.id)
    #expect(model.missionTaskRequests.latest?.command == .editTitle)

    let claimed = try #require(fixture.detail.tasks.first { $0.sessionId != nil })
    model.keyboardTarget = .missionTask(missionId: missionId, taskId: claimed.id)
    #expect(try #require(catalog.targetActions()).entries.contains { $0.item.title == "Open chat" })
    model.keyboardTarget = .missionTask(missionId: missionId, taskId: "gone")
    #expect(catalog.targetActions() == nil)
}
