import Foundation
import PilotCore
import Testing
@testable import Pilot

private let pilot = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
private let dotfiles = Project(id: "p2", name: "dotfiles", path: "/tmp/dotfiles", createdAt: 1)

@MainActor private func fixture() -> AppModel {
    let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "inbox-\(UUID())")!)
    app.client.loadFixture(projects: [pilot, dotfiles], sessions: [
        SessionSummary(id: "a", title: "a", cwd: "/tmp", projectId: "p1", createdAt: 1, updatedAt: 2, state: "idle"),
    ])
    return app
}

@Test @MainActor func inboxIsASelectionThatFollowsTheSidebarScope() {
    let app = fixture()
    app.selectedSessionId = "a"
    app.showInbox()
    #expect(app.showingInbox && app.selectedSessionId == nil && app.currentSelection == .inbox)
    // Switching scope keeps the Inbox open, now scoped to the focused project.
    app.focus(on: "p1")
    #expect(app.sidebarScope == "p1" && app.currentSelection == .inbox && app.selectedProjectId == nil)
    app.openOverview()
    #expect(app.selectedProjectId == "p1" && !app.showingInbox)
    app.focus(on: nil)
    // Back in every project, the selection left there (the Inbox) is restored.
    #expect(app.currentSelection == .inbox && app.selectedProjectId == nil)
    app.showArchive()
    #expect(!app.showingInbox && app.currentSelection == .archive(projectId: nil, missionId: nil))
    app.showInbox()
    app.newSession(in: nil)
    #expect(app.currentSelection == .home)
}

@Test func inboxSelectionIsRestoredInAnyScope() {
    #expect(SidebarSelection.restoring(.inbox, in: "p1", sessions: [], missions: [], projectIds: ["p1"]) == .inbox)
}

@Test func scopeTotalsAddTrackedItemsForTheInboxBadge() {
    let counts = ["p1": ProjectDashboardCount(working: 1, needsYou: 1, tracked: 3), "p2": ProjectDashboardCount(tracked: 2)]
    let total = SidebarScopeCounts.total(counts)
    #expect(total == ProjectDashboardCount(working: 1, needsYou: 1, tracked: 5))
    #expect(InboxText.badge(total) == 6)
    #expect(SidebarScopeCounts.summary(ProjectDashboardCount(tracked: 2)) == nil, "tracked items never interrupt")
}
