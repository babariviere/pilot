import Foundation
import Testing
@testable import PilotCore

private let prURL = "https://github.com/octo/repo/pull/42"

private func pr(_ number: Int, state: PullRequestState = .open, branch: String? = nil,
                repo: String = "octo/repo") -> SessionPullRequest {
    SessionPullRequest(number: number, url: "https://github.com/\(repo)/pull/\(number)", title: "Change \(number)",
                       state: state, checkedAt: 1, branch: branch)
}

private func chat(_ id: String, project: String? = "p", updatedAt: Double = 1, archived: Bool = false,
                  branch: String? = nil, prs: [SessionPullRequest] = [], bound: [String]? = nil,
                  mode: ChatMode? = nil, mission: String? = nil) -> SessionSummary {
    SessionSummary(id: id, title: "Chat \(id)", cwd: "/tmp", projectId: project, branch: branch, createdAt: 1,
                   updatedAt: updatedAt, state: "idle", pullRequest: prs.first, pullRequests: prs.isEmpty ? nil : prs,
                   boundPullRequests: bound, archivedAt: archived ? 2 : nil, mode: mode, missionId: mission)
}

@Test func pastedPullRequestLinksBecomeTheCanonicalDaemonForm() {
    let accepted = [
        prURL, " \(prURL)\n", "http://github.com/octo/repo/pull/42", "https://www.GitHub.com/octo/repo/pull/42",
        "github.com/octo/repo/pull/42", "\(prURL)/", "\(prURL)/files", "\(prURL)/commits/abc123", "\(prURL)?w=1#top",
    ]
    for raw in accepted { #expect(PullRequestURL.canonical(raw) == prURL, "\(raw)") }
    #expect(PullRequestURL.canonical("https://github.com/Octo/Repo.js/pull/7") == "https://github.com/Octo/Repo.js/pull/7")
    let rejected = [
        "", "42", "#42", "https://gitlab.com/octo/repo/pull/42", "https://github.com/octo/repo/issues/42",
        "https://github.com/octo/repo/pull/0", "https://github.com/octo/repo/pull/042", "https://github.com/octo/repo/pull/x",
        "https://github.com/octo/repo/pull/99999999999", "https://user@github.com/octo/repo/pull/42",
        "https://github.com:8443/octo/repo/pull/42", "ftp://github.com/octo/repo/pull/42",
        "https://github.com/octo/repo/pull/42/edit", "https://github.com//repo/pull/42",
        "https://github.com/octo/../pull/42", String(repeating: "a", count: 2049),
    ]
    for raw in rejected { #expect(PullRequestURL.canonical(raw) == nil, "\(raw)") }
    #expect(PullRequestURL.same("https://github.com/Octo/Repo/pull/42/files", prURL))
    #expect(!PullRequestURL.same("https://github.com/octo/repo/pull/43", prURL))
    #expect(PullRequestURL.number(of: "\(prURL)/files") == 42)
    #expect(PullRequestURL.number(of: "not a link") == nil)
}

@Test func summariesDecodeBoundPullRequestsAndShowAttachedHintsOffTheChatBranch() throws {
    let json = #"{"id":"s","title":"Chat","cwd":"/tmp","projectId":"p","branch":"feat/own","createdAt":1,"updatedAt":2,"state":"idle","pullRequests":[{"number":42,"url":"https://github.com/octo/repo/pull/42","title":"Fix","state":"open","branch":"external/fix","checkedAt":1},{"number":7,"url":"https://github.com/octo/repo/pull/7","title":"Own","state":"open","branch":"feat/own","checkedAt":1}],"boundPullRequests":["https://github.com/octo/repo/pull/42","https://github.com/octo/repo/pull/9"]}"#
    let session = try JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
    #expect(session.boundPullRequests?.count == 2)
    #expect(session.isBoundPullRequest("https://github.com/Octo/Repo/pull/42"))
    #expect(!session.isBoundPullRequest("https://github.com/octo/repo/pull/7"))
    #expect(session.tracksPullRequest("https://github.com/octo/repo/pull/7"))
    #expect(session.tracksPullRequest("https://github.com/octo/repo/pull/9"), "bound but not yet refreshed")
    #expect(session.pendingBoundPullRequests == ["https://github.com/octo/repo/pull/9"])
    let prs = session.linkedPullRequests
    #expect(session.showsAttachedHint(prs[0], current: "feat/own"))
    #expect(!session.showsAttachedHint(prs[1], current: "feat/own"), "discovered PRs have no hint")
    #expect(!session.showsAttachedHint(prs[0], current: "external/fix"), "a bound PR on the current branch needs none")
    // The head branch of a bound PR is listed as its own branch row.
    #expect(session.branchLinks(current: "feat/own").contains { $0.name == "external/fix" && $0.pullRequest?.number == 42 })

    let old = try JSONDecoder().decode(SessionSummary.self, from: Data(#"{"id":"s","title":"T","cwd":"/","createdAt":1,"updatedAt":2,"state":"idle"}"#.utf8))
    #expect(old.boundPullRequests == nil && old.pendingBoundPullRequests.isEmpty)
}

@Test func onlyProjectBuildChatsThatAreNotArchivedCanAttach() {
    #expect(chat("build").canAttachPullRequests)
    #expect(!chat("ask", mode: .ask).canAttachPullRequests)
    #expect(!chat("loose", project: nil).canAttachPullRequests)
    #expect(!chat("archived", archived: true).canAttachPullRequests)
}

@Test func attachingNamesTheChatThePullRequestMovesFrom() {
    let sessions = [
        chat("here", prs: [pr(7)]),
        chat("stale", updatedAt: 9, archived: true, prs: [pr(42)]),
        chat("discovered", updatedAt: 3, prs: [pr(42)]),
        chat("bound", updatedAt: 2, bound: [prURL]),
    ]
    #expect(PullRequestAttachment.owner(of: "https://github.com/Octo/Repo/pull/42", excluding: "here", in: sessions)?.id == "bound")
    #expect(PullRequestAttachment.owner(of: prURL, excluding: "here", in: Array(sessions.prefix(3)))?.id == "discovered")
    #expect(PullRequestAttachment.owner(of: "https://github.com/octo/repo/pull/7", excluding: "here", in: sessions) == nil)
}

@Test func suggestionsOfferOtherChatsOpenPullRequestsNewestFirst() {
    let here = chat("here", prs: [pr(7)])
    let sessions = [
        here,
        chat("a", prs: [pr(7), pr(10), pr(11, state: .merged), pr(12, state: .draft)]),
        chat("b", prs: [pr(10), pr(13)]),
        chat("archived", archived: true, prs: [pr(14)]),
        chat("elsewhere", project: "q", prs: [pr(15)]),
    ]
    let suggestions = PullRequestAttachment.suggestions(for: here, in: sessions)
    #expect(suggestions.map(\.pullRequest.number) == [13, 12, 10])
    #expect(suggestions.map(\.sessionId) == ["b", "a", "a"])
    #expect(PullRequestAttachment.suggestions(for: here, in: sessions, limit: 1).map(\.pullRequest.number) == [13])
    #expect(PullRequestAttachment.suggestions(for: chat("loose", project: nil), in: sessions).isEmpty)
}

private func missionDetail(tasks: [MissionTask], resources: [MissionResource] = []) -> MissionDetail {
    MissionDetail(mission: Mission(id: "m", projectId: "p", title: "M", goal: "g", createdAt: 1, updatedAt: 1),
                  brief: nil, decisions: [], comments: [], tasks: tasks, artifacts: [], resources: resources, events: [])
}

private func link(_ task: String?, url: String = prURL, addedBy: String? = nil,
                  kind: MissionResourceKind = .githubPullRequest) -> MissionResource {
    MissionResource(id: UUID().uuidString, taskId: task, pullRequest: nil, url: url, title: nil, kind: kind,
                    externalId: nil, addedBySessionId: addedBy, createdAt: 1)
}

@Test func taskChoicesPreferTheChatsClaimAndHideFinishedTasks() {
    let tasks = [
        MissionTask(id: "t1", number: 1, title: "Other", status: .todo, order: 1),
        MissionTask(id: "t2", number: 2, title: "Done", status: .done, order: 2, sessionId: "s"),
        MissionTask(id: "t3", number: 3, title: "Mine", status: .inProgress, order: 3, sessionId: "s"),
        MissionTask(id: "t4", number: 4, title: "Dropped", status: .dropped, order: 4),
        MissionTask(id: "t5", number: 5, title: "Theirs", status: .inProgress, order: 5, sessionId: "x"),
    ]
    let detail = missionDetail(tasks: tasks)
    #expect(PullRequestAttachment.taskChoices(for: "s", in: detail).map(\.number) == [3, 1, 5])
    #expect(PullRequestAttachment.defaultTask(for: "s", in: detail) == "t3")
    #expect(!PullRequestAttachment.allowsNoTask(for: "s", in: detail))
    #expect(PullRequestAttachment.defaultTask(for: "free", in: detail) == nil)
    #expect(PullRequestAttachment.allowsNoTask(for: "free", in: detail))
}

@Test func detachConfirmationNamesTheTasksItUnlinks() {
    let tasks = [
        MissionTask(id: "t34", number: 34, title: "Mine", status: .inProgress, sessionId: "s"),
        MissionTask(id: "t12", number: 12, title: "Linked by me", status: .inReview, sessionId: "x"),
        MissionTask(id: "t8", number: 8, title: "Someone else's", status: .inProgress, sessionId: "x"),
        MissionTask(id: "t9", number: 9, title: "Finished", status: .done, sessionId: "s"),
    ]
    let detail = missionDetail(tasks: tasks, resources: [
        link("t34", url: "https://github.com/Octo/Repo/pull/42"), link("t34"), link("t12", addedBy: "s"),
        link("t8"), link("t9"), link(nil), link("t34", url: "https://github.com/octo/repo/pull/43"),
        link("t34", kind: .url),
    ])
    let linked = PullRequestAttachment.linkedTasks(of: prURL, sessionId: "s", in: detail)
    #expect(linked.map(\.number) == [12, 34])
    #expect(PullRequestAttachment.detachPrompt(number: 42, tasks: []) == "Detach PR #42 from this chat?")
    #expect(PullRequestAttachment.detachPrompt(number: 12, tasks: [tasks[0]]) == "Detach PR #12 and unlink it from task #34?")
    #expect(PullRequestAttachment.detachPrompt(number: 42, tasks: linked + [tasks[2]])
        == "Detach PR #42 and unlink it from tasks #12, #34 and #8?")
}

@Test func attachDraftValidatesLinksAndRejectsPullRequestsAlreadyHere() {
    let session = chat("s", prs: [pr(7)], bound: ["https://github.com/octo/repo/pull/9"])
    var draft = PullRequestAttachDraft()
    #expect(draft.hint(for: session) == nil && !draft.canSubmit(for: session))
    draft.text = "octo/repo#42"
    #expect(draft.url == nil)
    #expect(draft.hint(for: session)?.hasPrefix("Paste a GitHub pull request link") == true)
    draft.text = "https://github.com/octo/repo/pull/7/files"
    #expect(draft.hint(for: session) == "Already attached to this chat.")
    draft.text = "https://github.com/octo/repo/pull/9"
    #expect(!draft.canSubmit(for: session), "bound but still loading counts as attached")
    draft.text = "\(prURL)/files"
    #expect(draft.url == prURL && draft.hint(for: session) == nil && draft.canSubmit(for: session))
    draft.busy = true
    #expect(!draft.canSubmit(for: session))
}
