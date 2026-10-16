import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func chatLinksRevealArchivedChatsAcrossProjectsWithoutRestoringThem() throws {
    let id = "abee494b-d1a8-484c-a57b-669148815d37"
    let defaults = try #require(UserDefaults(suiteName: "chat-links-\(UUID())"))
    let app = AppModel(projectFolderDefaults: defaults)
    app.client.loadFixture(projects: [
        Project(id: "p1", name: "One", path: "/tmp/one", createdAt: 1),
        Project(id: "p2", name: "Two", path: "/tmp/two", createdAt: 1),
    ], sessions: [SessionSummary(id: id, title: "Implementation", cwd: "/tmp/two", projectId: "p2",
                               createdAt: 1, updatedAt: 2, state: "idle", archivedAt: 3)])
    app.focus(on: "p1")
    let url = try #require(URL(string: "pilot://chat/\(id)"))
    let link = try #require(ChatDestination(url: url))
    app.reveal(chat: link)
    #expect(app.selectedSessionId == id)
    #expect(app.selectedProjectId == nil)
    #expect(app.sidebarScope == nil)
    #expect(app.client.session(id)?.isArchived == true)
    #expect(app.sessionActionError == nil)

    let missingURL = try #require(URL(string: "pilot://chat/00000000-0000-0000-0000-000000000000"))
    let missing = try #require(ChatDestination(url: missingURL))
    app.reveal(chat: missing)
    #expect(app.selectedSessionId == id)
    #expect(app.sessionActionError == "This chat is no longer available.")
}
