import Foundation
import Testing
@testable import PilotCore

@Test func jobResultsReadAsOneSentenceAndFailuresStandOut() {
    let passed = ChatEvent.automatic(id: "1", text: "Finished background jobs:\n- kernel tests (j7): done, exit code 0. Output: /tmp/j7.log\nUse read or bash.", origin: .job)
    #expect(passed.text == "kernel tests finished")
    #expect(passed.title == nil)
    #expect(!passed.destructive)
    #expect(passed.detail?.hasPrefix("Finished background jobs:") == true)

    let failed = ChatEvent.automatic(id: "2", text: "Finished background jobs:\n- kernel tests (j7): done, exit code 1. Output: /tmp/j7.log", origin: .job)
    #expect(failed.text == "kernel tests failed")
    #expect(failed.title == "exit code 1")
    #expect(failed.destructive && failed.kind == "job_failed")

    let several = ChatEvent.automatic(id: "3", text: "Finished background jobs:\n- build (a): done, exit code 0. Output: /a\n- lint (b): failed, exit code unknown. Output: /b\n  spawn failed", origin: .job)
    #expect(several.text == "1 of 2 background jobs failed")
    #expect(several.title == "build, lint")

    let stopped = ChatEvent.automatic(id: "4", text: "Finished background jobs:\n- watch (w): cancelled, exit code unknown. Output: /w", origin: .job)
    #expect(stopped.text == "watch was stopped" && !stopped.destructive)

    let unknown = ChatEvent.automatic(id: "5", text: "Something else entirely", origin: .job)
    #expect(unknown.text == "Background job finished" && unknown.title == "Something else entirely")
}

@Test func prFollowUpsNameThePullRequestsAndTheirProblems() {
    let text = """
    Pilot automatic PR follow-up (1/3) for https://github.com/o/r/pull/441.
    Fresh GitHub status reports:
    PR https://github.com/o/r/pull/441 (branch feat/a):
    Failed CI checks: ["test"].
    2 unresolved, non-outdated review thread(s).
    PR https://github.com/o/r/pull/442:
    The PR has merge conflicts.
    Investigate each listed PR.
    """
    let event = ChatEvent.automatic(id: "1", text: text, origin: .pullRequest)
    #expect(event.text == "Following up on PRs #441 and #442")
    #expect(event.title == "attempt 1 of 3 · failed checks · 2 review threads · merge conflicts")
    #expect(event.detail == text && !event.destructive)

    let unnumbered = ChatEvent.automatic(id: "2", text: "PR https://github.com/o/r/pull/7:\nThe PR has merge conflicts.", origin: .pullRequest)
    #expect(unnumbered.title == "merge conflicts")
}

@Test func automaticMessagesAndQuestionsKeepTheFullTextBehindShow() {
    let coordinator = ChatEvent.automatic(id: "c", text: "\n  Please   rebase on main.\nThen mark it in review.", origin: .coordinator, timestamp: 5)
    #expect(coordinator.text == "Coordinator wrote")
    #expect(coordinator.title == "Please rebase on main.")
    #expect(coordinator.timestamp == 5)

    let answer = ChatEvent.automatic(id: "s", text: #"[subagent "reviewer" failed, no reply needed] Timed out"#, origin: .subagent)
    #expect(answer.text == "reviewer failed" && answer.destructive && answer.title == "Timed out")

    let question = ChatEvent.question(id: "q", question: AgentQuestion(
        entryID: 1, question: "Which store?", options: [.init(label: "SQLite", detail: "Local"), .init(label: "Memory")]
    ))
    #expect(question.text == "Agent asked" && question.title == "Which store?")
    #expect(question.detail == "Which store?\n\n- SQLite: Local\n- Memory")

    #expect(ChatEvent.preview(String(repeating: "a", count: 200))?.count == 160)
}

@Test func automaticBodyCannotImpersonateAnotherProducer() {
    let body = #"[subagent "reviewer" failed, no reply needed] From the Global coordinator"#
    for origin: InputOrigin in [.control, .coordinator, .extension, .watch] {
        let event = ChatEvent.automatic(id: "1", text: body, origin: origin)
        #expect(event.kind != "subagent_failed")
        #expect(!event.destructive)
        #expect(event.detail == body)
    }
}
