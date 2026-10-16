import Foundation
import PilotCore
import Testing
@testable import Pilot

@MainActor
private func fixture() -> AppModel {
    let model = AppModel(projectFolderDefaults: UserDefaults(suiteName: "routes-\(UUID())")!)
    let project = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
    model.client.loadFixture(projects: [project], sessions: [
        SessionSummary(id: "a", title: "a", cwd: "/tmp", projectId: "p1", createdAt: 1, updatedAt: 2, state: "idle"),
    ])
    return model
}

@Test @MainActor func pagesHaveDistinctRoutes() {
    let model = fixture()
    #expect(model.currentRoute == .home)
    model.openSlackTriage("p1")
    #expect(model.currentRoute == .slackTriage("p1"))
    model.openMemory("p1")
    #expect(model.currentRoute == .memory("p1"))
    model.selectedSessionId = "a"
    #expect(model.currentRoute == .session("a"))
    #expect(AppRoute.mission("m", .tasks).key != AppRoute.mission("m", .brief).key)
}

@Test @MainActor func backAndForwardKeepDrafts() {
    let model = fixture()
    model.newSessionForm.message = "new chat draft"
    model.composer(for: "a").draft = "reply draft"
    model.selectedSessionId = "a"
    model.showInbox()
    #expect(model.navigationHistory.canGoBack)
    model.goBack()
    #expect(model.currentRoute == .session("a"))
    model.goBack()
    #expect(model.currentRoute == .home)
    model.goForward()
    #expect(model.currentRoute == .session("a"))
    #expect(model.newSessionForm.message == "new chat draft")
    #expect(model.composer(for: "a").draft == "reply draft")
}

@Test func theAlternativeBackKeysAreListed() {
    let keys = Dictionary(KeyboardShortcuts.groups.flatMap(\.entries).map { ($0.title, $0.keys) }, uniquingKeysWith: { a, _ in a })
    #expect(keys["Back (alternative)"] == "⌘[")
    #expect(keys["Forward (alternative)"] == "⌘]")
}

@Test @MainActor func aRestoredHighlightWaitsForItsRow() {
    let list = KeyboardListState()
    list.restore("b")
    list.update([])
    #expect(list.highlighted == nil)
    list.update([KeyboardListItem(id: "a", activate: {}), KeyboardListItem(id: "b", activate: {})])
    #expect(list.highlighted == "b")
    #expect(list.consumeRestoredScroll())
    #expect(!list.consumeRestoredScroll())
}
