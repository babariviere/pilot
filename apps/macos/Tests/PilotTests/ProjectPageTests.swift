import Foundation
import PilotCore
import Testing
@testable import Pilot

private let now = Date(timeIntervalSince1970: 1_000_000)
private let nowMs = now.timeIntervalSince1970 * 1000

private func need(_ kind: DashboardNeedsYouKind, _ id: String, session: String? = nil, mission: String? = nil,
                  outcome: SessionOutcome? = nil, reason: String? = nil, count: Int? = nil,
                  at: Double = nowMs - 12 * 60_000) -> DashboardNeedsYouItem {
    DashboardNeedsYouItem(kind: kind, id: id, title: id, sessionId: session, missionId: mission, outcome: outcome,
                          reason: reason, count: count, at: at)
}

private func pullRequest(_ state: DashboardPullRequestState = .open,
                         readiness: DashboardPullRequestReadiness? = nil) -> DashboardPullRequest {
    DashboardPullRequest(number: 1, url: "https://github.com/a/b/pull/1", title: "PR", state: state,
                         sessionId: "s", sessionTitle: "Chat", checkedAt: 1, readiness: readiness)
}

@Test func headlineSummarizesWorkNeedsAndReadyPullRequests() {
    let summary = ProjectDashboardSummary(chats: 9, working: 3, needsYou: 3, openPullRequests: 4, readyPullRequests: 1)
    #expect(ProjectPageText.headline(summary, needsYou: 3, lastFinishedAt: nil, now: now)
        == "3 chats are working and 3 things need you. 1 pull request is ready to merge.")
    let single = ProjectDashboardSummary(chats: 2, working: 1, openPullRequests: 2)
    #expect(ProjectPageText.headline(single, needsYou: 1, lastFinishedAt: nil, now: now)
        == "1 chat is working and 1 thing needs you. 2 pull requests are open.")
    #expect(ProjectPageText.headline(ProjectDashboardSummary(chats: 2), needsYou: 2, lastFinishedAt: nil, now: now)
        == "2 things need you.")
}

@Test func quietHeadlineSaysWhenTheLastChatFinished() {
    let quiet = ProjectDashboardSummary(chats: 2)
    #expect(ProjectPageText.headline(quiet, needsYou: 0, lastFinishedAt: nil, now: now) == "Nothing is running.")
    #expect(ProjectPageText.headline(quiet, needsYou: 0, lastFinishedAt: nowMs - 10_000, now: now)
        == "Nothing is running. The last chat finished just now.")
    let yesterday = ProjectPageText.headline(quiet, needsYou: 0, lastFinishedAt: nowMs - 86_400_000, now: now)
    #expect(yesterday.hasPrefix("Nothing is running. The last chat finished "))
    #expect(!yesterday.contains("just now"))
}

@Test func needsYouRowsExplainWhatHappenedAndOfferOneAction() {
    let failed = need(.failed, "f", session: "f", outcome: .failed, reason: "kernel exited with code 137")
    #expect(ProjectPageText.needsSubtitle(failed, now: now) == "Failed 12m ago: kernel exited with code 137")
    #expect(ProjectPageText.needsAction(failed) == "Open chat")
    let unread = need(.unread, "u", session: "u", outcome: .done)
    #expect(ProjectPageText.needsSubtitle(unread, now: now) == "Finished 12m ago.")
    #expect(ProjectPageText.needsAction(unread) == "Review")
    let stopped = need(.unread, "s", session: "s", outcome: .stopped, at: nowMs - 5_000)
    #expect(ProjectPageText.needsSubtitle(stopped, now: now) == "Stopped just now.")
    let question = need(.question, "q", mission: "m", count: 2)
    #expect(ProjectPageText.needsSubtitle(question, now: now) == "2 questions or blocked tasks are waiting on you.")
    #expect(ProjectPageText.needsAction(question) == "Answer")
    // Nothing to open yet: the row is shown without an action.
    #expect(ProjectPageText.needsAction(need(.scheduledFailed, "x")) == nil)
}

@Test func pullRequestsWithoutReadinessReadAsOpen() {
    #expect(PullRequestReadinessStyle(pullRequest()).kind == .open)
    #expect(PullRequestReadinessStyle(pullRequest()).label == "Open")
    #expect(PullRequestReadinessStyle(pullRequest(.draft, readiness: .init(state: .ready))).label == "Draft")
    #expect(PullRequestReadinessStyle(pullRequest(readiness: .init(state: .ready))).label == "Ready to merge")
    #expect(PullRequestReadinessStyle(pullRequest(readiness: .init(state: .pending))).kind == .pending)
    let blocked = PullRequestReadinessStyle(pullRequest(readiness: .init(state: .blocked,
                                                                         reasons: ["2 unresolved comments", "conflicts"])))
    #expect(blocked.kind == .blocked && blocked.label == "2 unresolved comments · conflicts")
    #expect(PullRequestReadinessStyle(pullRequest(readiness: .init(state: .blocked))).label == "Blocked")
}

@Test func workingMetaNamesModeModelAndBranch() {
    let item = DashboardWorkingItem(sessionId: "s", title: "t", mode: .build, model: "anthropic/claude-opus-5-5",
                                    branch: "feat/x", startedAt: 1)
    #expect(ProjectPageText.workingMeta(item) == "Build · claude-opus-5-5 · feat/x")
    #expect(ProjectPageText.workingMeta(DashboardWorkingItem(sessionId: "s", title: "t", mode: .ask, startedAt: 1)) == "Ask")
}

@Test func staleBannerSaysHowOldTheShownDataIs() {
    let received = now.addingTimeInterval(-10)
    #expect(ProjectPageText.staleDetail(receivedAt: received, error: nil, now: now)
        == "Waiting for pilotd to reconnect. Showing what Pilot knew just now.")
    #expect(ProjectPageText.staleDetail(receivedAt: received, error: "HTTP 500", now: now)
        == "HTTP 500. Showing what Pilot knew just now.")
}

@Test @MainActor func dashboardStateIsDroppedWithTheLastSubscriber() {
    let client = PilotClient()
    client.retainDashboard("p")
    client.handle(.dashboard(ProjectDashboard(projectId: "p")))
    #expect(client.projectDashboards["p"] != nil)
    #expect(client.dashboardReceivedAt["p"] != nil)
    client.releaseDashboard("p")
    #expect(client.projectDashboards["p"] == nil)
    #expect(client.dashboardReceivedAt["p"] == nil)
    #expect(client.dashboardErrors["p"] == nil)
}

@Test @MainActor func projectPageIsOneOfTheExclusiveDetailSelections() {
    let app = AppModel()
    app.showArchive()
    app.openProject("p")
    #expect(app.selectedProjectId == "p" && !app.showingArchive)
    app.openMission("m")
    #expect(app.selectedMissionId == "m" && app.selectedProjectId == nil)
    app.openProject("p")
    #expect(app.selectedProjectId == "p" && app.selectedMissionId == nil)
    app.selectedSessionId = "s"
    #expect(app.selectedProjectId == nil)
    app.openProject("p")
    #expect(app.selectedSessionId == nil && app.selectedProjectId == "p")
    app.newSession(in: "p")
    #expect(app.selectedProjectId == nil)
}
