import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test func navigationHistoryCoalescesDuplicatesAndDropsForwardVisitsAfterANewVisit() {
    var history = NavigationHistory("home")
    history.record("chat-a")
    history.record("chat-a")
    history.record("chat-b")
    #expect(history.entries == ["home", "chat-a", "chat-b"])
    #expect(history.move(-1, accepting: { _ in true }) == "chat-a")
    history.record("chat-a")
    #expect(history.canGoForward)
    history.record("project")
    #expect(history.entries == ["home", "chat-a", "project"])
    #expect(!history.canGoForward)
}

@Test func navigationHistoryIsBoundedAndSkipsRemovedDestinationsInBothDirections() {
    var history = NavigationHistory(0, limit: 4)
    for id in 1...6 { history.record(id) }
    #expect(history.entries == [3, 4, 5, 6])
    #expect(history.move(-1, accepting: { $0 != 5 }) == 4)
    #expect(history.entries == [3, 4, 6])
    #expect(history.move(-1, accepting: { _ in true }) == 3)
    #expect(history.move(-1, accepting: { _ in true }) == nil)
    #expect(!history.canGoBack)
    #expect(history.move(1, accepting: { $0 != 4 }) == 6)
    #expect(history.move(1, accepting: { _ in true }) == nil)
    #expect(!history.canGoForward)
}

@MainActor private func navigationFixture() throws -> AppModel {
    let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "navigation-\(UUID())")!)
    try app.registerLocal(HostRef(hostId: "local", daemonId: "daemon", lineageId: "lineage"))
    app.client.loadFixture(projects: [
        Project(id: "p1", name: "One", path: "/tmp/one", createdAt: 1),
        Project(id: "p2", name: "Two", path: "/tmp/two", createdAt: 1),
    ], sessions: [
        SessionSummary(id: "a", title: "A", cwd: "/tmp/one", projectId: "p1", createdAt: 1, updatedAt: 1, state: "idle"),
        SessionSummary(id: "b", title: "B", cwd: "/tmp/two", projectId: "p2", createdAt: 1, updatedAt: 1, state: "idle"),
    ])
    let mission = try JSONDecoder().decode(MissionDetail.self, from: Data("""
    {"mission":{"id":"m","projectId":"p1","title":"Mission","goal":"","status":"active","briefRevision":1,
    "createdAt":1,"updatedAt":1},"decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]}
    """.utf8))
    app.client.loadMissionFixture([mission])
    return app
}

@Test @MainActor func navigationBackAndForwardRestoreChatsAndScopeWithoutIntermediatePages() throws {
    let app = try navigationFixture()
    app.focus(on: "p1")
    app.selectedSessionId = "a" // Sidebar and creation paths can assign the selection directly.
    app.reveal(session: "b") // Widens the scope and selects the chat as a single navigation.
    #expect(app.navigationHistory.entries.count == 4)
    #expect(app.sidebarScope == nil && app.currentSelection == .session("b"))
    app.goBack()
    #expect(app.sidebarScope == "p1" && app.currentSelection == .session("a"))
    app.goBack()
    #expect(app.sidebarScope == "p1" && app.currentSelection == .project("p1"))
    app.goBack()
    #expect(app.sidebarScope == nil && app.currentSelection == .home)
    app.goBack()
    #expect(app.currentSelection == .home)
    app.goForward()
    app.goForward()
    #expect(app.sidebarScope == "p1" && app.currentSelection == .session("a"))
    app.goForward()
    #expect(app.sidebarScope == nil && app.currentSelection == .session("b"))
    #expect(!app.navigationHistory.canGoForward)
}

@Test @MainActor func navigationRestoresMissionInboxArchiveAndProjectSubpages() throws {
    let app = try navigationFixture()
    app.openMemory("p1")
    app.openSlackTriage("p1", caseId: "case")
    app.openMission("m")
    app.showInbox(for: "p2")
    app.showArchive(in: "p1", missionId: "m")
    app.openProject("p2")
    app.goBack()
    #expect(app.currentSelection == .archive(projectId: "p1", missionId: "m"))
    app.goBack()
    #expect(app.currentSelection == .inbox && app.inboxProjectId == "p2")
    app.goBack()
    #expect(app.currentSelection == .mission("m"))
    app.goBack()
    #expect(app.selectedProjectId == "p1" && app.slackTriageProjectId == "p1" && app.slackTriageCaseId == "case")
    app.goBack()
    #expect(app.memoryProjectId == "p1" && app.slackTriageProjectId == nil)
    app.goForward()
    #expect(app.slackTriageProjectId == "p1" && app.memoryProjectId == nil)
    app.openProject("p1")
    #expect(!app.navigationHistory.canGoForward)
}

@Test @MainActor func navigationSkipsDeletedChatsAndPreservesUnsentDrafts() throws {
    let app = try navigationFixture()
    app.newSessionForm.message = "Unsent Home draft"
    let composer = app.composer(for: "a")
    composer.draft = "Unsent chat draft"
    app.reveal(session: "a")
    app.reveal(session: "b")
    app.client.loadFixture(projects: app.client.projects, sessions: app.client.sessions.filter { $0.id != "a" })
    app.goBack()
    #expect(app.currentSelection == .home)
    #expect(app.newSessionForm.message == "Unsent Home draft")
    #expect(composer.draft == "Unsent chat draft")
    app.goForward()
    #expect(app.currentSelection == .session("b"))
}

@Test @MainActor func navigationKeepsRemoteIdentityAndCachedDisconnectedDestinations() async throws {
    let app = try navigationFixture()
    let remote = HostRef(hostId: "remote", daemonId: "other", lineageId: "remote-lineage")
    let remoteClient = PilotClient()
    remoteClient.loadFixture(projects: app.client.projects, sessions: app.client.sessions)
    try loadClientFixture(remoteClient, host: remote, into: app.hosts)
    let context = HostViewContext(host: remote, hosts: app.hosts)
    let remoteChat = context.ref(.session, "a")
    app.focus(on: context.ref(.project, "p1").storageKey)
    try app.selectSession(remoteChat)
    app.showInbox(for: "p1", context: context)
    app.openHome()
    await app.hosts.disconnect(remote)
    app.goBack()
    #expect(app.currentSelection == .inbox && app.inboxHost == remote)
    app.goBack()
    #expect(app.selectedSessionId == remoteChat.storageKey)
    #expect(app.hosts.selection == remoteChat)
    #expect(app.sidebarScope == context.ref(.project, "p1").storageKey)
    app.reveal(session: "a")
    app.goBack()
    #expect(app.hosts.selection == remoteChat)
}

@Test @MainActor func navigationNeverFallsBackToLocalForAMissingRemoteChat() throws {
    let app = try navigationFixture()
    let remote = HostRef(hostId: "removed", daemonId: "other", lineageId: "old-lineage")
    let ref = HostResourceRef(host: remote, kind: .session, localId: "a")
    app.reveal(session: "b")
    try app.selectSession(ref)
    app.openProject("p2")
    app.goBack()
    #expect(app.currentSelection == .session("b"))
    #expect(app.hosts.selection?.host == app.localHost)
    app.goBack()
    #expect(app.currentSelection == .home)
}
