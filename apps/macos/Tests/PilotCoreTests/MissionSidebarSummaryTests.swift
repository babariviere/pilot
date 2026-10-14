import Foundation
import Testing
@testable import PilotCore

private func mission(done: Int? = nil, total: Int? = nil, needsYou: Int = 0) -> Mission {
    Mission(id: "m", projectId: "p", title: "Mission", goal: "", createdAt: 1, updatedAt: 1,
            needsYouCount: needsYou, tasksDone: done, tasksTotal: total)
}

private func member(_ id: String, state: String = "idle", outcome: SessionOutcome? = nil, reason: String? = nil,
                    error: String? = nil, missionId: String? = "m", archived: Bool = false,
                    ready: Bool = false, coordinator: Bool = false) -> SessionSummary {
    let request = ready ? SessionPullRequest(number: 1, url: "https://github.com/example/repo/pull/1", title: "PR",
                                             state: .open, checkedAt: 1,
                                             readiness: .init(state: .ready, reasons: [], checkedAt: 1)) : nil
    return SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, state: state, error: error,
                          outcome: outcome, outcomeAt: outcome == nil ? nil : 2, outcomeReason: reason,
                          pullRequest: request, pullRequests: request.map { [$0] },
                          archivedAt: archived ? 3 : nil, missionId: missionId,
                          activeMissionCoordinator: coordinator ? true : nil)
}

@Test func missionProgressReadsTasksThenWorkingChats() {
    #expect(MissionSidebarSummary.progress(mission: mission(done: 3, total: 12), working: 2)
        == "3 of 12 tasks · 2 working")
    #expect(MissionSidebarSummary.progress(mission: mission(done: 1, total: 1), working: 0) == "1 of 1 task")
    #expect(MissionSidebarSummary.progress(mission: mission(done: 0, total: 0), working: 1) == "No tasks · 1 working")
    // Out-of-range counts never read as more done than exist.
    #expect(MissionSidebarSummary.progress(mission: mission(done: 9, total: 4), working: 0) == "4 of 4 tasks")
    // An older daemon sends no task counts: say only what is known.
    #expect(MissionSidebarSummary.progress(mission: mission(), working: 3) == "3 working")
    #expect(MissionSidebarSummary.progress(mission: mission(), working: 0) == nil)
}

@Test func missionSummaryDecodesProgressAndAttentionTogether() throws {
    let json = """
    {"id":"m","projectId":"p","title":"Mission","goal":"","status":"active",
     "briefRevision":0,"createdAt":1,"updatedAt":1,"needsYouCount":1,
     "needsYouReason":"Blocked: Review","tasksDone":3,"tasksTotal":12}
    """
    let summary = try JSONDecoder().decode(Mission.self, from: Data(json.utf8))
    #expect(summary.needsYouCount == 1)
    #expect(summary.needsYouReason == "Blocked: Review")
    #expect(MissionSidebarSummary.progress(mission: summary, working: 2) == "3 of 12 tasks · 2 working")
    #expect(MissionSidebarSummary.signal(mission: summary, members: [], isUnread: { _ in false }) == .needsYou)
    #expect(try JSONDecoder().decode(Mission.self, from: JSONEncoder().encode(summary)) == summary)
}

@Test func missionCornerShowsTheMostUrgentChatState() {
    let none: (SessionSummary) -> Bool = { _ in false }
    let quiet = member("quiet", outcome: .done)
    let working = member("working", state: "working")
    let ready = member("ready", outcome: .done, ready: true)
    let asking = member("asking", outcome: .question)
    let failed = member("failed", outcome: .failed)
    #expect(MissionSidebarSummary.signal(mission: mission(), members: [quiet], isUnread: none) == nil)
    #expect(MissionSidebarSummary.signal(mission: mission(), members: [quiet, working], isUnread: none) == .working)
    #expect(MissionSidebarSummary.signal(mission: mission(), members: [working, ready], isUnread: none) == .readyToMerge)
    #expect(MissionSidebarSummary.signal(mission: mission(), members: [ready, asking], isUnread: none) == .needsYou)
    #expect(MissionSidebarSummary.signal(mission: mission(), members: [asking, failed, working], isUnread: none)
        == .failed)
    // Unread results need the user; blocked tasks or comments do too, without any chat.
    #expect(MissionSidebarSummary.signal(mission: mission(), members: [quiet], isUnread: { _ in true }) == .needsYou)
    #expect(MissionSidebarSummary.signal(mission: mission(needsYou: 1), members: [], isUnread: none) == .needsYou)
    // Archived chats and chats of other missions do not count.
    let archived = member("archived", outcome: .failed, archived: true)
    let other = member("other", outcome: .failed, missionId: "elsewhere")
    #expect(MissionSidebarSummary.signal(mission: mission(), members: [archived, other], isUnread: none) == nil)
}

@Test func coordinatorLineNamesItsReasonOrState() {
    func detail(_ session: SessionSummary, unread: Bool = false) -> String {
        MissionCoordinatorStatus.detail(session, unread: unread)
    }
    #expect(detail(member("c", state: "working", coordinator: true)) == "Working")
    var paused = member("c", state: "working", coordinator: true)
    paused.sleepPaused = true
    #expect(detail(paused) == "Paused until wake")
    #expect(detail(member("c", outcome: .question, reason: "Start #1, #3?\nDetails follow", coordinator: true))
        == "Asks: Start #1, #3?")
    #expect(detail(member("c", outcome: .question, coordinator: true)) == "Asks a question")
    #expect(detail(member("c", outcome: .failed, error: "exit code 1", coordinator: true)) == "Failed: exit code 1")
    #expect(detail(member("c", outcome: .failed, coordinator: true)) == "Failed")
    #expect(detail(member("c", outcome: .stopped, coordinator: true)) == "Stopped")
    #expect(detail(member("c", outcome: .done, coordinator: true)) == "Idle")
    #expect(detail(member("c", outcome: .done, coordinator: true), unread: true) == "New result")
    #expect(detail(member("c", coordinator: true)) == "Idle")
}

@Test func repositoryTooltipCarriesTheCountsRowsNoLongerShow() {
    let summary = SessionChangeSummary(base: "origin/main", fileCount: 3, additions: 13, deletions: 2)
    let text = SessionRepositoryHelp.text(summary: summary, branch: "fix/x", error: nil)
    #expect(text == summary.helpText + "\nBranch: fix/x")
    #expect(text?.contains("3 files") == true)
    #expect(text?.contains("13 lines added, 2 lines deleted") == true)
    #expect(SessionRepositoryHelp.text(summary: nil, branch: "", error: "Offline") == "Git changes unavailable: Offline")
    #expect(SessionRepositoryHelp.text(summary: nil, branch: nil, error: nil) == nil)
}
