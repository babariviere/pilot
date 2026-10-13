import Foundation
import PilotCore
import Testing
@testable import Pilot

private let pilot = Project(id: "p1", name: "pilot", path: "/tmp/pilot", createdAt: 1)
private let dotfiles = Project(id: "p2", name: "dotfiles", path: "/tmp/dotfiles", createdAt: 1)

private func chat(_ id: String, project: String?, outcome: SessionOutcome? = nil, state: String = "idle",
                  archived: Bool = false) -> SessionSummary {
    SessionSummary(id: id, title: id, cwd: "/tmp", projectId: project, createdAt: 1, updatedAt: 2, state: state,
                   outcome: outcome, outcomeAt: outcome == nil ? nil : 2, archivedAt: archived ? 3 : nil)
}

private func mission(_ id: String, project: String) throws -> MissionDetail {
    try JSONDecoder().decode(MissionDetail.self, from: Data("""
    {"mission":{"id":"\(id)","projectId":"\(project)","title":"\(id)","goal":"","status":"active","briefRevision":1,
    "createdAt":1,"updatedAt":1},"decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]}
    """.utf8))
}

@MainActor private func fixture() throws -> AppModel {
    let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "sidebar-scope-\(UUID())")!)
    app.client.loadFixture(projects: [pilot, dotfiles],
                           sessions: [chat("a", project: "p1"), chat("b", project: "p2"), chat("c", project: "p1")])
    app.client.loadMissionFixture([try mission("m1", project: "p1"), try mission("m2", project: "p2")])
    return app
}

@Test @MainActor func focusingOpensProjectHomeAndRemembersSelectionPerScope() throws {
    let app = try fixture()
    app.selectedSessionId = "b"
    app.focus(on: "p1")
    // A scope seen for the first time opens its Home: the project page.
    #expect(app.sidebarScope == "p1" && app.selectedProjectId == "p1" && app.selectedSessionId == nil)
    app.selectedSessionId = "c"
    app.focus(on: nil)
    #expect(app.sidebarScope == nil && app.selectedSessionId == "b")
    app.focus(on: "p1")
    #expect(app.selectedSessionId == "c")
    app.openMission("m1")
    app.focus(on: "p2")
    #expect(app.selectedProjectId == "p2" && app.selectedMissionId == nil)
    app.focus(on: "p1")
    #expect(app.selectedMissionId == "m1")
}

@Test @MainActor func focusIgnoresUnknownProjectsAndTheCurrentScope() throws {
    let app = try fixture()
    app.focus(on: "missing")
    #expect(app.sidebarScope == nil)
    app.focus(on: "p1")
    app.selectedSessionId = "a"
    app.focus(on: "p1")
    #expect(app.selectedSessionId == "a")
}

@Test @MainActor func openingAChatFromAnotherProjectShowsAllProjects() throws {
    let app = try fixture()
    app.focus(on: "p1")
    app.reveal(session: "a")
    #expect(app.sidebarScope == "p1" && app.selectedSessionId == "a")
    app.reveal(session: "b")
    #expect(app.sidebarScope == nil && app.selectedSessionId == "b")
}

@Test @MainActor func scopeHomeAndNewChatFollowTheFocusedProject() throws {
    let app = try fixture()
    app.draftProjectId = "p2"
    app.selectedSessionId = "a"
    app.openScopeHome()
    #expect(app.selectedSessionId == nil && app.selectedProjectId == nil && app.draftProjectId == "p2")
    app.focus(on: "p1")
    app.selectedSessionId = "a"
    app.openScopeHome()
    #expect(app.selectedProjectId == "p1")
    app.newChatInScope()
    #expect(app.draftProjectId == "p1" && app.selectedProjectId == nil)
}

@Test @MainActor func removedFocusedProjectFallsBackToAllProjects() throws {
    let app = try fixture()
    app.focus(on: "p1")
    app.client.loadFixture(projects: [dotfiles], sessions: [chat("b", project: "p2")])
    app.validateSidebarScope()
    #expect(app.sidebarScope == nil && app.selectedProjectId == nil)
}

@Test @MainActor func projectOrderFollowsTheSidebarFolders() throws {
    let app = try fixture()
    #expect(app.orderedProjects.map(\.id) == ["p1", "p2"])
    let created = app.projectFolders.create(name: "Personal")
    let folder = try #require(created)
    app.projectFolders.move(projectId: "p2", to: folder.id)
    #expect(app.orderedProjects.map(\.id) == ["p2", "p1"])
}

@Test func restoringDropsSelectionsOutsideTheScope() throws {
    let sessions = [chat("a", project: "p1"), chat("b", project: "p2")]
    let missions = [try mission("m1", project: "p1").mission]
    let projects: Set<String> = ["p1", "p2"]
    func restore(_ saved: SidebarSelection?, _ scope: String?) -> SidebarSelection {
        SidebarSelection.restoring(saved, in: scope, sessions: sessions, missions: missions, projectIds: projects)
    }
    #expect(restore(nil, "p1") == .home)
    #expect(restore(.session("a"), "p1") == .session("a"))
    #expect(restore(.session("b"), "p1") == .home)
    #expect(restore(.session("gone"), nil) == .home)
    #expect(restore(.mission("m1"), "p2") == .home)
    #expect(restore(.mission("m1"), nil) == .mission("m1"))
    #expect(restore(.project("p2"), nil) == .project("p2"))
    #expect(restore(.project("p1"), "p1") == .home)
    #expect(restore(.archive(projectId: "p2", missionId: "m1"), "p1") == .archive(projectId: "p1", missionId: "m1"))
    #expect(restore(.archive(projectId: "gone", missionId: "gone"), nil) == .archive(projectId: nil, missionId: nil))
}

@Test func scopeCountsUseDaemonTotalsWithoutSubtractingReviewsAgain() {
    let counts = ProjectDashboardCounts(projects: [
        "p1": ProjectDashboardCount(working: 2, needsYou: 2),
        "p2": ProjectDashboardCount(needsYou: 1),
    ]).projects
    #expect(SidebarScopeCounts.total(counts) == ProjectDashboardCount(working: 2, needsYou: 3))
    #expect(SidebarScopeCounts.total(counts, excluding: "p1") == ProjectDashboardCount(needsYou: 1))
}

@Test func elsewhereLineAppearsOnlyWithActivity() {
    #expect(SidebarScopeCounts.elsewhere(ProjectDashboardCount()) == nil)
    #expect(SidebarScopeCounts.elsewhere(ProjectDashboardCount(working: 1, needsYou: 1))
        == "Elsewhere: 1 working · 1 needs you")
    #expect(SidebarScopeCounts.elsewhere(ProjectDashboardCount(needsYou: 3)) == "Elsewhere: 3 need you")
    #expect(SidebarScopeCounts.elsewhere(ProjectDashboardCount(working: 1, needsYou: 2), compact: true)
        == "Elsewhere: 2 need you")
    #expect(SidebarScopeCounts.elsewhere(ProjectDashboardCount(working: 1), compact: true) == "Elsewhere: 1 working")
    #expect(SidebarScopeCounts.summary(ProjectDashboardCount(working: 4)) == "4 working")
}
