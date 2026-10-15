import Foundation
import PilotCore
import Testing
@testable import Pilot

private func homeSession(_ id: String, project: String? = "p", state: String = "idle", at: Double = 1,
                         archived: Bool = false, readyPR: Bool = false, mission: String? = nil) -> SessionSummary {
    SessionSummary(id: id, title: id, cwd: "/tmp", projectId: project, createdAt: at, updatedAt: at, state: state,
                   pullRequest: readyPR ? SessionPullRequest(number: 1, url: "https://example.com/pr/1", title: "PR",
                                                             state: .open, checkedAt: 1,
                                                             readiness: PullRequestReadiness(state: .ready, reasons: [],
                                                                                             checkedAt: 1)) : nil,
                   archivedAt: archived ? 3 : nil, missionId: mission)
}

private func homeMission(_ id: String, project: String = "p", status: MissionStatus = .active, at: Double = 1,
                         coordinator: String? = nil, done: Int? = nil, total: Int? = nil) -> Mission {
    Mission(id: id, projectId: project, title: id, goal: "", status: status, coordinatorSessionId: coordinator,
            createdAt: at, updatedAt: at, tasksDone: done, tasksTotal: total)
}

private func project(_ id: String, _ name: String? = nil) -> Project {
    Project(id: id, name: name ?? id, path: "/tmp/\(id)", createdAt: 1)
}

@Test func homeProjectRowsGroupUnderFoldersKeepingUrgencyOrderAndLimit() throws {
    var folders = ProjectFolders()
    // Swift Testing's macros cannot take a mutating call; create the folder first.
    let created = folders.create(name: "Work")
    let work = try #require(created)
    _ = folders.create(name: "Empty")
    folders.move(projectId: "quiet", to: work.id)
    folders.move(projectId: "busy", to: work.id)
    let rows = HomeStatus.projects(
        [project("quiet"), project("busy"), project("loose"), project("other")],
        counts: ["busy": ProjectDashboardCount(working: 1), "loose": ProjectDashboardCount(needsYou: 1)],
        sessions: [], missions: [])
    let sections = HomeStatus.folderSections(rows, folders: folders)
    // Folder order first (empty folders left out), urgency order within each, ungrouped projects last.
    #expect(sections.map { $0.folder?.name } == ["Work", nil])
    #expect(sections.map { $0.items.map(\.id) } == [["busy", "quiet"], ["loose", "other"]])
    let limited = HomeStatus.folderSections(rows, folders: folders, limit: 3)
    #expect(limited.map { $0.items.map(\.id) } == [["busy", "quiet"], ["loose"]])
    #expect(HomeStatus.folderSections(rows, folders: folders, limit: 2).map { $0.items.map(\.id) } == [["busy", "quiet"]])
}

@Test func homeProjectRowsCombineCountsReadyPullRequestsMissionsAndActivity() {
    let rows = HomeStatus.projects(
        [project("p"), project("q")],
        counts: ["p": ProjectDashboardCount(working: 2, needsYou: 1, tracked: 3)],
        sessions: [homeSession("a", at: 5, readyPR: true), homeSession("b", at: 9), homeSession("old", at: 50, archived: true),
                   homeSession("c", project: "q", at: 2), homeSession("folder", project: nil, at: 99, readyPR: true)],
        missions: [homeMission("Release", done: 3, total: 12), homeMission("Gone", status: .done)])
    let p = rows[0]
    #expect(p.id == "p" && p.readyToMerge == 1 && p.lastActivity == 9)
    #expect(p.missions.map(\.id) == ["Release"])
    #expect(p.signal == .needsYou)
    #expect(p.countsLine == "2 working · 1 needs you · 1 ready to merge")
    #expect(p.missionLine == "Release: 3 of 12 tasks")
    #expect(rows[1].signal == nil && rows[1].countsLine == "Quiet" && rows[1].missionLine == nil && !rows[1].isActive)
    #expect(HomeStatus.inboxCount(rows) == 5)
}

@Test func homeProjectsSortByUrgencyThenActivityThenName() {
    let projects = ["quiet-b", "quiet-a", "working", "failed", "ready", "mission", "needs"].map { project($0) }
    let rows = HomeStatus.projects(projects, counts: [
        "working": ProjectDashboardCount(working: 1),
        "failed": ProjectDashboardCount(needsYou: 1, needsYouReasons: ["failed": 1]),
        "needs": ProjectDashboardCount(working: 3, needsYou: 2, needsYouReasons: ["asks": 2]),
    ], sessions: [homeSession("r", project: "ready", readyPR: true)],
       missions: [homeMission("m", project: "mission"), homeMission("m2", project: "mission", done: 1, total: 2)])
    #expect(rows.map(\.id) == ["failed", "needs", "ready", "working", "mission", "quiet-a", "quiet-b"])
    #expect(rows[0].signal == .failed)
    #expect(rows[4].missionLine == "2 missions: 1 of 2 tasks")
}

@Test func homeSummarySentenceCountsActiveProjectsWorkMissionsAndInbox() {
    let rows = HomeStatus.projects(
        [project("a"), project("b"), project("c"), project("d")],
        counts: ["a": ProjectDashboardCount(working: 2, needsYou: 1, tracked: 4),
                 "b": ProjectDashboardCount(working: 1)],
        sessions: [homeSession("r", project: "c", readyPR: true)], missions: [homeMission("m", project: "a")])
    #expect(HomeStatus.summary(rows)
        == "3 projects are active: 3 chats are working and 1 mission is moving. 6 things wait in your Inbox.")
    let one = HomeStatus.projects([project("a")], counts: ["a": ProjectDashboardCount(working: 1)], sessions: [], missions: [])
    #expect(HomeStatus.summary(one) == "1 project is active: 1 chat is working. Your Inbox is empty.")
    let waiting = HomeStatus.projects([project("a")], counts: ["a": ProjectDashboardCount(tracked: 1)], sessions: [], missions: [])
    #expect(HomeStatus.summary(waiting) == "Nothing is working. 1 thing waits in your Inbox.")
    #expect(HomeStatus.summary([]) == "All quiet. Nothing is working and your Inbox is empty.")
}

@Test func homeWorkingListsLiveChatsNewestFirst() {
    let sessions = [homeSession("idle"), homeSession("old", state: "working", at: 1),
                    homeSession("new", state: "working", at: 5), homeSession("gone", state: "working", archived: true)]
    #expect(HomeStatus.working(sessions).map(\.id) == ["new", "old"])
}

@Test func homeListsEveryMissionWithActiveBeforeDoneAndArchived() {
    let missions = [homeMission("archive", status: .archived, at: 9), homeMission("done", status: .done, at: 10),
                    homeMission("old"), homeMission("b", at: 2), homeMission("a", at: 2)]
    #expect(HomeStatus.missions(missions).map(\.id) == ["b", "a", "old", "done", "archive"])
    #expect(HomeStatus.missions([]).isEmpty)
}

@Test func homeCoordinatorLinksIncludeArchivedChatsButNotMissingChats() {
    let ids: Set<String> = ["archived-coordinator"]
    #expect(HomeStatus.coordinator(homeMission("m", coordinator: "archived-coordinator"), sessionIds: ids)
        == "archived-coordinator")
    #expect(HomeStatus.coordinator(homeMission("m", coordinator: "missing"), sessionIds: ids) == nil)
    #expect(HomeStatus.coordinator(homeMission("m"), sessionIds: ids) == nil)
}

@Test func homeLargeSnapshotProjectRowsCost() {
    let projects = (0..<50).map { project("p\($0)") }
    let sessions = (0..<10_000).map { homeSession("s\($0)", project: "p\($0 % 50)", at: Double($0), archived: $0 % 10 != 0) }
    let start = Date()
    for _ in 0..<20 {
        #expect(HomeStatus.projects(projects, counts: [:], sessions: sessions, missions: []).count == 50)
    }
    print("Home 10,000-session snapshot: project rows \(Date().timeIntervalSince(start) * 1_000 / 20) ms")
}

@Test func homeShowsSubscriptionUsageOncePerProviderFromTheNewestSnapshot() {
    func chat(_ id: String, _ usage: SubscriptionUsage?) -> SessionSummary {
        SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle",
                       usage: SessionUsage(subscription: usage))
    }
    let old = SubscriptionUsage(fetchedAt: 1, provider: .anthropic, windows: [SubscriptionWindow(label: "5h", usedPercent: 10)])
    let new = SubscriptionUsage(fetchedAt: 5, provider: .anthropic, windows: [SubscriptionWindow(label: "5h", usedPercent: 34),
                                                                              SubscriptionWindow(label: "Week", usedPercent: 61)])
    let failed = SubscriptionUsage(fetchedAt: 9, provider: .anthropic, windows: [], error: "Timed out")
    let codex = SubscriptionUsage(fetchedAt: 2, provider: .openai, windows: [SubscriptionWindow(label: "Week", usedPercent: 12)])
    let usage = HomeStatus.subscriptions([chat("codex", codex), chat("old", old), chat("new", new), chat("failed", failed),
                                          chat("none", nil)])
    #expect(usage == [new, codex])
    #expect(HomeStatus.subscriptions([chat("none", nil)]).isEmpty)
}

@Test @MainActor func homeLinksNavigateFromMissionToArchivedCoordinatorChat() {
    let name = "home-navigation-\(UUID())"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    let app = AppModel(projectFolderDefaults: defaults)
    let coordinator = homeSession("coordinator", archived: true)
    let mission = homeMission("mission", coordinator: coordinator.id)
    app.client.loadFixture(projects: [], sessions: [coordinator])
    app.client.handle(.missions([mission]))
    app.openMission(mission.id)
    #expect(app.selectedMissionId == mission.id && app.selectedSessionId == nil)
    let id = HomeStatus.coordinator(mission, sessionIds: Set(app.client.sessions.map(\.id)))!
    app.reveal(session: id)
    #expect(app.selectedSessionId == coordinator.id && app.selectedMissionId == nil)
}
