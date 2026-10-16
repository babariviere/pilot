import Foundation
import Testing
@testable import PilotCore

private func session(_ id: String, state: String = "idle", outcome: SessionOutcome? = nil,
                     pr: PullRequestState? = nil, readiness: PullRequestReadiness.State? = nil,
                     pinned: Bool? = nil) -> SessionSummary {
    let request = pr.map { state in
        SessionPullRequest(number: 1, url: "https://github.com/example/repo/pull/1", title: "PR", state: state,
                           checkedAt: 1, readiness: readiness.map { .init(state: $0, reasons: [], checkedAt: 1) })
    }
    return SessionSummary(id: id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, state: state,
                          outcome: outcome, outcomeAt: outcome == nil ? nil : 2,
                          pullRequest: request, pullRequests: request.map { [$0] } ?? [], pinned: pinned)
}

@Test func signalsFollowTheAttentionBudget() {
    #expect(session("w", state: "working").signal(unread: true) == .working)
    #expect(session("f", outcome: .failed).signal(unread: true) == .failed)
    #expect(session("u", outcome: .done).signal(unread: true) == .needsYou)
    #expect(session("r", outcome: .done, pr: .open, readiness: .ready).signal(unread: false) == .readyToMerge)
    #expect(session("r", outcome: .done, pr: .open, readiness: .ready).signal(unread: true) == .readyToMerge)
    #expect(session("r", outcome: .done, pr: .open, readiness: .ready).needsYouReason(unread: true) == nil)
    #expect(session("f", outcome: .failed, pr: .open, readiness: .ready).signal(unread: true) == .failed)
    #expect(session("a", outcome: .question, pr: .open, readiness: .ready).signal(unread: false) == .needsYou)
    #expect(session("p", outcome: .done, pr: .open, readiness: .pending).signal(unread: false) == nil)
    #expect(session("d", outcome: .done, pr: .draft, readiness: .ready).signal(unread: false) == nil)
    #expect(session("q", outcome: .done).signal(unread: false) == nil)
    // An agent question needs the user until it is answered, even once viewed.
    #expect(session("a", outcome: .question).signal(unread: false) == .needsYou)
    #expect(!session("a", outcome: .question).isQuiet)
    // A failure whose PR has since merged no longer asks for attention.
    #expect(session("m", outcome: .failed, pr: .merged).signal(unread: false) == nil)
}

@Test func scheduledMessageTakesChatOutOfNeedsYou() {
    func scheduled(_ value: SessionSummary) -> SessionSummary {
        var value = value
        value.scheduledMessage = true
        return value
    }
    let question = scheduled(session("q", outcome: .question))
    let failed = scheduled(session("f", outcome: .failed))
    let unread = scheduled(session("u", outcome: .done))
    let ready = scheduled(session("r", outcome: .done, pr: .open, readiness: .ready))
    #expect(question.signal(unread: true) == nil)
    #expect(failed.signal(unread: true) == nil)
    #expect(unread.signal(unread: true) == nil)
    #expect(question.needsYouReason(unread: true) == nil)
    #expect(ready.signal(unread: true) == .readyToMerge)
    // Scheduling from the open chat is an explicit answer: it leaves Needs you at once.
    let groups = SidebarUrgency.groups([question, failed, unread], unread: { _ in true }, held: { _ in true })
    #expect(groups.needsYou.isEmpty)
    #expect(groups.recent.map(\.id) == ["q", "f", "u"])
}

@Test func urgencyGroupsPutFailuresFirstAndKeepListOrder() {
    let sessions = [
        session("quiet", outcome: .done),
        session("unread", outcome: .done),
        session("working", state: "working"),
        session("failed", outcome: .failed),
        session("ready", outcome: .done, pr: .open, readiness: .ready),
        session("working-2", state: "working"),
    ]
    let groups = SidebarUrgency.groups(sessions) { $0.id == "unread" }
    #expect(groups.needsYou.map(\.id) == ["failed", "unread"])
    #expect(groups.working.map(\.id) == ["working", "working-2"])
    #expect(groups.readyToMerge.map(\.id) == ["ready"])
    #expect(groups.recent.map(\.id) == ["quiet"])
    #expect(SidebarUrgency.groups([]) { _ in false }.isEmpty)
}

@Test func readyToMergeIsItsOwnGroupBelowNeedsYou() {
    let sessions = [
        session("ready", outcome: .done, pr: .open, readiness: .ready),
        session("pending", outcome: .done, pr: .open, readiness: .pending),
        session("draft", outcome: .done, pr: .draft, readiness: .ready),
        session("merged", outcome: .done, pr: .merged, readiness: .ready),
        session("ready-unread", outcome: .done, pr: .open, readiness: .ready),
        session("ready-viewed", outcome: .done, pr: .open, readiness: .ready),
        session("ready-working", state: "working", pr: .open, readiness: .ready),
        session("ready-2", outcome: .done, pr: .open, readiness: .ready),
    ]
    let groups = SidebarUrgency.groups(sessions, unread: { $0.id == "ready-unread" },
                                       held: { $0.id == "ready-viewed" })
    // Ready PRs supersede unreviewed and held results; live work stays under Working.
    #expect(groups.needsYou.isEmpty)
    #expect(groups.readyToMerge.map(\.id) == ["ready", "ready-unread", "ready-viewed", "ready-2"])
    #expect(groups.working.map(\.id) == ["ready-working"])
    #expect(groups.recent.map(\.id) == ["pending", "draft", "merged"])
    #expect(!SidebarUrgency.Groups(readyToMerge: [sessions[0]]).isEmpty)
}

@Test func urgencyGroupsPutQuestionsBetweenFailuresAndUnreadResults() {
    let sessions = [
        session("unread", outcome: .done),
        session("question", outcome: .question),
        session("failed", outcome: .failed),
        session("question-2", outcome: .question),
    ]
    // Questions need the user even when already viewed, so unread is false for them here.
    let groups = SidebarUrgency.groups(sessions) { $0.id == "unread" }
    #expect(groups.needsYou.map(\.id) == ["failed", "question", "question-2", "unread"])
}

@Test func quietChatsAreFinishedWithoutOpenWork() {
    #expect(session("done", outcome: .done).isQuiet)
    #expect(session("merged", outcome: .done, pr: .merged).isQuiet)
    #expect(!session("open", outcome: .done, pr: .open).isQuiet)
    #expect(!session("working", state: "working").isQuiet)
    #expect(!session("failed", outcome: .failed).isQuiet)
}

@Test func resultsReadInTheOpenChatStayUnderNeedsYou() {
    let sessions = [session("quiet", outcome: .done), session("viewed", outcome: .done), session("unread", outcome: .done)]
    let groups = SidebarUrgency.groups(sessions, unread: { $0.id == "unread" }, held: { $0.id == "viewed" })
    #expect(groups.needsYou.map(\.id) == ["viewed", "unread"])
    #expect(groups.recent.map(\.id) == ["quiet"])
}

@Test func pinnedChatsLeadInTheirOwnGroupWhateverTheirState() {
    let sessions = [
        session("pinned-failed", outcome: .failed, pinned: true),
        session("pinned-working", state: "working", pinned: true),
        session("pinned-unread", outcome: .done, pinned: true),
        session("pinned-ready", outcome: .done, pr: .open, readiness: .ready, pinned: true),
        session("failed", outcome: .failed),
        session("unread", outcome: .done),
        session("quiet", outcome: .done),
    ]
    let unread = { (session: SessionSummary) in session.id.hasSuffix("unread") }
    let groups = SidebarUrgency.groups(sessions, unread: unread, held: { $0.id == "pinned-failed" })
    // A pinned chat is listed only in Pinned, in list order; its corner still carries its state.
    #expect(groups.pinned.map(\.id) == ["pinned-failed", "pinned-working", "pinned-unread", "pinned-ready"])
    #expect(groups.needsYou.map(\.id) == ["failed", "unread"])
    #expect(groups.working.isEmpty)
    #expect(groups.readyToMerge.isEmpty)
    #expect(groups.recent.map(\.id) == ["quiet"])
    #expect(groups.pinned.map { $0.signal(unread: unread($0)) } == [.failed, .working, .needsYou, .readyToMerge])
    #expect(!SidebarUrgency.Groups(pinned: [sessions[0]]).isEmpty)

    // Counts that must match pilotd's keep pinned chats in the group of their state.
    let counted = SidebarUrgency.groups(sessions, unread: unread, separatingPinned: false)
    #expect(counted.pinned.isEmpty)
    #expect(counted.needsYou.map(\.id) == ["pinned-failed", "failed", "pinned-unread", "unread"])
    #expect(counted.working.map(\.id) == ["pinned-working"])
}
