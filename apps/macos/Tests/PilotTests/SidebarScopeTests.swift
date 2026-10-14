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

@Test @MainActor func focusingOpensOverviewAndRemembersSelectionPerScope() throws {
    let app = try fixture()
    app.selectedSessionId = "b"
    app.focus(on: "p1")
    // A project seen for the first time opens its Overview.
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

@Test @MainActor func homeCoversEveryProjectWhileNewChatFollowsTheFocus() throws {
    let app = try fixture()
    app.draftProjectId = "p2"
    app.selectedSessionId = "a"
    app.openHome()
    #expect(app.selectedSessionId == nil && app.selectedProjectId == nil && app.draftProjectId == "p2")
    app.focus(on: "p1")
    app.selectedSessionId = "a"
    app.openOverview()
    #expect(app.selectedProjectId == "p1" && app.selectedSessionId == nil)
    // Home stays the all-projects Home even when the sidebar is focused.
    app.openHome()
    #expect(app.sidebarScope == "p1" && app.currentSelection == .home && app.draftProjectId == "p2")
    app.newChatInScope()
    #expect(app.draftProjectId == "p1" && app.selectedProjectId == nil)
}

@Test @MainActor func homeIsRestoredAsHomeInAFocusedScope() throws {
    let app = try fixture()
    app.focus(on: "p1")
    app.openHome()
    app.focus(on: "p2")
    #expect(app.selectedProjectId == "p2")
    app.focus(on: "p1")
    #expect(app.currentSelection == .home && app.sidebarScope == "p1")
    app.openOverview()
    app.focus(on: nil)
    // Leaving Home in every project and returning restores it, never a project page.
    #expect(app.currentSelection == .home)
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
    #expect(restore(nil, "p1") == .project("p1"))
    #expect(restore(nil, nil) == .home)
    #expect(restore(.home, "p1") == .home)
    #expect(restore(.session("a"), "p1") == .session("a"))
    #expect(restore(.session("b"), "p1") == .project("p1"))
    #expect(restore(.session("gone"), nil) == .home)
    #expect(restore(.mission("m1"), "p2") == .project("p2"))
    #expect(restore(.mission("m1"), nil) == .mission("m1"))
    #expect(restore(.project("p2"), nil) == .project("p2"))
    #expect(restore(.project("p1"), "p1") == .project("p1"))
    #expect(restore(.project("p2"), "p1") == .project("p1"))
    #expect(restore(.project("gone"), nil) == .home)
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

@Test func inboxBadgeHelpSumsReasonsWhenTheyCoverTheCount() {
    #expect(SidebarScopeCounts.needsYouReasons(total: 0, reasons: NeedsYouReasons()) == nil)
    #expect(SidebarScopeCounts.needsYouReasons(total: 5, reasons: NeedsYouReasons(questions: 2, failed: 1,
                                                                                   notReviewed: 2))
        == "5 need you: 2 questions, 1 failed, 2 not reviewed")
    #expect(SidebarScopeCounts.needsYouReasons(total: 1, reasons: NeedsYouReasons(questions: 1))
        == "1 needs you: 1 question")
    // Reasons that do not add up to the count (missions, other sources) leave the total alone.
    #expect(SidebarScopeCounts.needsYouReasons(total: 3, reasons: NeedsYouReasons(failed: 1)) == "3 need you")
    #expect(SidebarScopeCounts.needsYouReasons(total: 2, reasons: NeedsYouReasons()) == "2 need you")
    #expect(SidebarScopeCounts.summary(ProjectDashboardCount(working: 4)) == "4 working")
    let counts = ["p1": ProjectDashboardCount(needsYou: 1, needsYouReasons: ["asks": 1]),
                  "p2": ProjectDashboardCount(needsYou: 2, needsYouReasons: ["mission": 1, "couldnt_start": 1])]
    #expect(SidebarScopeCounts.needsYouReasons(total: 3, reasons: NeedsYouReasons(), counts: counts)
        == "3 need you: 1 question, 1 couldn't start, 1 mission")
}

@Test func needsYouReasonsCountTheUrgencyGroup() {
    let sessions = [chat("f", project: "p1", outcome: .failed), chat("q", project: "p1", outcome: .question),
                    chat("d", project: "p2", outcome: .done), chat("w", project: "p1", state: "working")]
    let groups = SidebarUrgency.groups(sessions, unread: { _ in true })
    let reasons = NeedsYouReasons(groups.needsYou, unread: { _ in true })
    #expect(reasons == NeedsYouReasons(questions: 1, failed: 1, notReviewed: 1))
    #expect(SidebarScopeCounts.needsYouReasons(total: 2, reasons: NeedsYouReasons(failed: 1, limited: 1))
        == "2 need you: 1 failed, 1 limit reached")
}
