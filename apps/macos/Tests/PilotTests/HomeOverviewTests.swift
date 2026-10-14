import Foundation
import PilotCore
import Testing
@testable import Pilot

private func homeAgent(_ id: String, outcome: SessionOutcome? = .done, at: Double? = 2,
                       state: String = "idle", archived: Bool = false, terminalPR: Bool = false,
                       coordinator: Bool = false) -> SessionSummary {
    SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, state: state,
                   outcome: outcome, outcomeAt: at,
                   pullRequest: terminalPR ? SessionPullRequest(number: 1, url: "https://example.com/pr/1",
                                                               title: "PR", state: .merged, checkedAt: 1) : nil,
                   archivedAt: archived ? 3 : nil, activeMissionCoordinator: coordinator)
}

private func homeMission(_ id: String, status: MissionStatus = .active, at: Double = 1,
                         coordinator: String? = nil) -> Mission {
    Mission(id: id, projectId: "p", title: id, goal: "", status: status, coordinatorSessionId: coordinator,
            createdAt: at, updatedAt: at)
}

@Test func homeAttentionIncludesOnlyUnreviewedResultsAndLegacyFailures() {
    let sessions = [homeAgent("done"), homeAgent("failed", outcome: .failed), homeAgent("stopped", outcome: .stopped),
                    homeAgent("running", state: "working"), homeAgent("archive", archived: true),
                    homeAgent("merged", terminalPR: true), homeAgent("quiet", outcome: nil, at: nil),
                    homeAgent("seen"), homeAgent("seen-failure", outcome: .failed),
                    homeAgent("legacy", outcome: nil, at: nil, state: "failed")]
    let items = HomeOverviewLists.agents(sessions) { !$0.id.hasPrefix("seen") }
    #expect(Set(items.map(\.id)) == ["done", "failed", "stopped", "legacy"])
    #expect(items.prefix(2).allSatisfy { $0.status == .failed })
}

@Test func homeAttentionSortsByFailureThenResultTimeWithStableTies() {
    let sessions = [homeAgent("old", at: 1), homeAgent("new", at: 4), homeAgent("b", at: 2),
                    homeAgent("a", at: 2), homeAgent("failure", outcome: .failed, at: 0)]
    #expect(HomeOverviewLists.agents(sessions) { _ in true }.map(\.id) == ["failure", "new", "b", "a", "old"])
    #expect(HomeOverviewLists.agents([]) { _ in true }.isEmpty)
}

@Test func homeAttentionKeepsActiveCoordinatorsWithSettledPRs() {
    let coordinator = homeAgent("coordinator", terminalPR: true, coordinator: true)
    #expect(HomeOverviewLists.agents([coordinator]) { _ in true }.map(\.id) == ["coordinator"])
}

@Test func homeAttentionUsesPersistentReviewVersions() {
    let name = "home-attention-\(UUID())"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    let attention = SessionAttention(defaults: defaults)
    let failed = homeAgent("failed", outcome: .failed)
    #expect(HomeOverviewLists.agents([failed], isUnread: attention.isUnread).count == 1)
    attention.review(failed, chatVisible: true, appActive: true)
    #expect(HomeOverviewLists.agents([failed], isUnread: attention.isUnread).isEmpty)
    #expect(HomeOverviewLists.agents([homeAgent("failed", outcome: .failed, at: 3)],
                                    isUnread: attention.isUnread).count == 1)
}

@Test func homeListsEveryMissionWithActiveBeforeDoneAndArchived() {
    let missions = [homeMission("archive", status: .archived, at: 9), homeMission("done", status: .done, at: 10),
                    homeMission("old"), homeMission("b", at: 2), homeMission("a", at: 2)]
    #expect(HomeOverviewLists.missions(missions).map(\.id) == ["b", "a", "old", "done", "archive"])
    #expect(HomeOverviewLists.missions([]).isEmpty)
}

@Test func homeCoordinatorLinksIncludeArchivedChatsButNotMissingChats() {
    let sessions = [homeAgent("archived-coordinator", archived: true)]
    let ids = Set(sessions.map(\.id))
    #expect(HomeOverviewLists.coordinator(homeMission("m", coordinator: "archived-coordinator"), sessionIds: ids)
        == "archived-coordinator")
    #expect(HomeOverviewLists.coordinator(homeMission("m", coordinator: "missing"), sessionIds: ids) == nil)
    #expect(HomeOverviewLists.coordinator(homeMission("m"), sessionIds: ids) == nil)
}

@Test func homeFullListsAreNotTruncatedToThePreviewLimit() {
    let sessions = (0..<40).map { homeAgent("s\($0)", at: Double($0)) }
    #expect(HomeOverviewLists.agents(sessions) { _ in true }.count == 40)
    #expect(HomeOverviewLists.missions((0..<40).map { homeMission("m\($0)") }).count == 40)
    #expect(HomeOverviewLists.previewLimit == 5)
}

@Test func homeLargeSnapshotSelectionCost() {
    let sessions = (0..<10_000).map { homeAgent("s\($0)", at: Double($0), archived: $0 % 10 != 0) }
    let baselineStart = Date()
    for _ in 0..<20 {
        #expect(sessions.filter { !$0.isArchived && $0.isIdleAwaitingReview }.count == 1_000)
    }
    let baseline = Date().timeIntervalSince(baselineStart) * 1_000 / 20
    let start = Date()
    for _ in 0..<20 {
        #expect(HomeOverviewLists.agents(sessions) { _ in true }.count == 1_000)
    }
    print("Home 10,000-session snapshot: prior idle filter \(baseline) ms; added attention selection \(Date().timeIntervalSince(start) * 1_000 / 20) ms")
}

@Test @MainActor func homeLinksNavigateFromMissionToArchivedCoordinatorChat() {
    let name = "home-navigation-\(UUID())"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    let app = AppModel(projectFolderDefaults: defaults)
    let coordinator = homeAgent("coordinator", archived: true)
    let mission = homeMission("mission", coordinator: coordinator.id)
    app.client.loadFixture(projects: [], sessions: [coordinator])
    app.client.handle(.missions([mission]))
    app.openMission(mission.id)
    #expect(app.selectedMissionId == mission.id && app.selectedSessionId == nil)
    let id = HomeOverviewLists.coordinator(mission, sessionIds: Set(app.client.sessions.map(\.id)))!
    app.reveal(session: id)
    #expect(app.selectedSessionId == coordinator.id && app.selectedMissionId == nil)
    #expect(app.client.session(coordinator.id)?.isArchived == true)
}
