import Foundation
import Testing
@testable import PilotCore

private func ready(_ number: Int, session: String, checkedAt: Double = 1) -> DashboardPullRequest {
    DashboardPullRequest(number: number, url: "https://github.com/o/r/pull/\(number)", title: "PR \(number)",
                         sessionId: session, sessionTitle: session, checkedAt: checkedAt, readiness: .init(state: .ready))
}

private func pending(_ number: Int, session: String) -> DashboardPullRequest {
    DashboardPullRequest(number: number, url: "https://github.com/o/r/pull/\(number)", title: "PR \(number)",
                         sessionId: session, sessionTitle: session, checkedAt: 1, readiness: .init(state: .pending))
}

private func needs(_ id: String, kind: DashboardNeedsYouKind = .unread, session: String? = nil) -> DashboardNeedsYouItem {
    DashboardNeedsYouItem(kind: kind, id: id, title: id, sessionId: session, at: 1)
}

private func working(_ session: String) -> DashboardWorkingItem {
    DashboardWorkingItem(sessionId: session, title: session, state: .working, mode: .build, startedAt: 1)
}

@Test func upNextListsNeedsYouThenReadyPullRequestsUpToThree() {
    let dashboard = ProjectDashboard(
        projectId: "p",
        summary: .init(needsYou: 2, openPullRequests: 3, readyPullRequests: 2),
        needsYou: .init(total: 2, items: [needs("a", kind: .failed, session: "s1"), needs("b", session: "s2")]),
        pullRequests: .init(total: 3, items: [ready(1, session: "s3"), ready(2, session: "s4"), pending(3, session: "s5")])
    )
    let overview = ProjectOverview(dashboard)
    #expect(overview.upNext.map(\.id) == ["needs:a", "needs:b", "ready:https://github.com/o/r/pull/1"])
    #expect(overview.upNext.map(\.signal) == [.failed, .needsYou, .readyToMerge])
    #expect(overview.inboxTotal == 4)
    #expect(overview.inboxLinkTitle == "Open Inbox (4)")
    #expect(overview.pullRequests.map(\.number) == [3])
    #expect(overview.pullRequestTotal == 1)
}

@Test func upNextSkipsReadyPullRequestsOfBusyChats() {
    let dashboard = ProjectDashboard(
        projectId: "p",
        summary: .init(openPullRequests: 3, readyPullRequests: 3),
        needsYou: .init(total: 2, items: [needs("q", kind: .question, session: "s1"),
                                         needs("x", kind: .scheduledFailed, session: "s3")]),
        working: .init(total: 1, items: [working("s2")]),
        pullRequests: .init(total: 3, items: [ready(1, session: "s1"), ready(2, session: "s2"), ready(3, session: "s3")])
    )
    let overview = ProjectOverview(dashboard)
    // s1 needs the user and s2 works; a failed schedule targeting s3 does not hold its pull request back.
    #expect(overview.upNext.map(\.id) == ["needs:q", "needs:x", "ready:https://github.com/o/r/pull/3"])
    #expect(overview.inboxTotal == 3)
    #expect(overview.pullRequests.isEmpty && overview.pullRequestTotal == 0)
}

@Test func overviewCountsRowsPastTheSectionLimit() {
    let dashboard = ProjectDashboard(
        projectId: "p",
        summary: .init(openPullRequests: 9, readyPullRequests: 6),
        needsYou: .init(total: 7, items: (0..<5).map { needs("n\($0)", session: "s\($0)") }),
        pullRequests: .init(total: 9, items: (10..<15).map { ready($0, session: "r\($0)") })
    )
    let overview = ProjectOverview(dashboard)
    #expect(overview.upNext.count == 3)
    #expect(overview.upNext.allSatisfy { if case .needsYou = $0 { true } else { false } })
    #expect(overview.inboxTotal == 13)
    // Pending pull requests sit past the limit, behind five ready ones: still counted for "Show all".
    #expect(overview.pullRequests.isEmpty && overview.pullRequestTotal == 3)
    #expect(ProjectOverview(ProjectDashboard(projectId: "p")).inboxLinkTitle == "Open Inbox")
}

@Test func missionAndRecentCornersFallBackToDashboardFigures() {
    #expect(DashboardMission(id: "m", title: "m", working: 1, needsYou: 1).signal == .needsYou)
    #expect(DashboardMission(id: "m", title: "m", working: 2).signal == .working)
    #expect(DashboardMission(id: "m", title: "m").signal == nil)
    let recent = { (outcome: SessionOutcome) in
        DashboardRecentItem(sessionId: "s", title: "t", outcome: outcome, outcomeAt: 1).signal
    }
    #expect(recent(.failed) == .failed && recent(.question) == .needsYou)
    #expect(recent(.done) == nil && recent(.stopped) == nil)
}

