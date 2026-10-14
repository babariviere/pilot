import Foundation
import Testing
@testable import PilotCore

private func row(_ id: String, pinned: Bool? = nil, state: String = "idle",
                 prs: [PullRequestState] = [], coordinator: Bool? = nil,
                 unpublished: Bool? = nil) -> SessionSummary {
    let requests = prs.enumerated().map { index, state in
        SessionPullRequest(number: index + 1, url: "https://github.com/example/repo/pull/\(index + 1)",
                           title: "PR", state: state, checkedAt: 1)
    }
    return SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, state: state,
                          pullRequest: requests.first, pullRequests: requests, pinned: pinned,
                          activeMissionCoordinator: coordinator, unpublishedWork: unpublished)
}

@Test func shortSidebarListsStayWhole() {
    let sessions = (0..<6).map { row("s\($0)", prs: [.merged]) }
    let result = SidebarSessionList.collapsed(sessions, limit: 5) { _ in false }
    #expect(result.shown.map(\.id) == sessions.map(\.id))
    #expect(result.hidden == 0)
}

@Test func longSidebarListsFoldBeyondTheLimitButKeepImportantChats() {
    var sessions = (0..<10).map { row("s\($0)", prs: [.merged]) }
    sessions[7] = row("pinned-late", pinned: true, prs: [.closed])
    let result = SidebarSessionList.collapsed(sessions, limit: 3) { $0.id == "s8" }
    #expect(result.shown.map(\.id) == ["s0", "s1", "s2", "pinned-late", "s8"])
    #expect(result.hidden == 5)
}

@Test func longSidebarListsKeepEveryActiveChatWithoutADisclosure() {
    let sessions = (0..<30).map { index in
        row("s\(index)", state: index % 2 == 0 ? "idle" : "parked",
            prs: [index % 3 == 1 ? .open : .draft])
    }
    let result = SidebarSessionList.collapsed(sessions) { _ in false }
    #expect(result.shown == sessions)
    #expect(result.hidden == 0)
}

@Test func sidebarFoldsOnlyQuietChatsAndPreservesOrder() {
    let sessions = (0..<5).map { row("s\($0)") } + [
        row("merged", prs: [.merged]),
        row("idle"),
        row("closed", prs: [.closed]),
        row("open", prs: [.open]),
        row("draft", prs: [.draft]),
        row("all-settled", prs: [.merged, .closed]),
        row("open-secondary", prs: [.merged, .open]),
        row("draft-secondary", prs: [.closed, .draft]),
        row("coordinator", prs: [.merged], coordinator: true),
        row("unpublished", prs: [.closed], unpublished: true),
        row("failed", state: "failed"),
    ]
    let result = SidebarSessionList.collapsed(sessions) { _ in false }
    #expect(result.shown.map(\.id) == ["s0", "s1", "s2", "s3", "s4", "open", "draft",
                                      "open-secondary", "draft-secondary", "coordinator", "failed"])
    #expect(result.hidden == 5)
}

@Test func sidebarKeepsSelectedWorkingAndUnreadTerminalChats() {
    let sessions = (0..<5).map { row("s\($0)") } + [
        row("selected", prs: [.merged]),
        row("working", state: "working", prs: [.closed]),
        row("starting", state: "starting", prs: [.merged]),
        row("unread", prs: [.closed]),
        row("folded", prs: [.merged]),
    ]
    let result = SidebarSessionList.collapsed(sessions) {
        $0.id == "selected" || $0.isWorking || $0.id == "unread"
    }
    #expect(result.shown.map(\.id) == ["s0", "s1", "s2", "s3", "s4", "selected", "working", "starting", "unread"])
    #expect(result.hidden == 1)
}

@Test func sidebarPRReopeningRemovesTheFoldWhenNothingCanHide() {
    let prefix = (0..<5).map { row("s\($0)") }
    let settled = prefix + [row("a", prs: [.merged]), row("b", prs: [.closed])]
    #expect(SidebarSessionList.collapsed(settled) { _ in false }.hidden == 2)
    let reopened = prefix + [row("a", prs: [.open]), row("b", prs: [.draft])]
    let result = SidebarSessionList.collapsed(reopened) { _ in false }
    #expect(result.shown == reopened)
    #expect(result.hidden == 0)
}

@Test func largeSidebarListsKeepAllActiveRows() {
    let sessions = (0..<10_000).map { index in
        row("s\(index)", prs: index % 2 == 0 ? [.open] : [.merged])
    }
    let result = SidebarSessionList.collapsed(sessions) { _ in false }
    #expect(result.shown.map(\.id) == sessions.enumerated().filter { $0.offset < 5 || $0.offset % 2 == 0 }.map { $0.element.id })
    #expect(result.hidden == 4_998)
}
