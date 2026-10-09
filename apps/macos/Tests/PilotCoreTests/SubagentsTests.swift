import Foundation
import Testing
@testable import PilotCore

private func decodeSession(_ extra: String = "") throws -> SessionSummary {
    try JSONDecoder().decode(SessionSummary.self, from: Data("""
    {"id":"s1","title":"Subagents","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle"\(extra)}
    """.utf8))
}

@Test func subagentsDecodeFromSessionSummariesAndStayOptional() throws {
    #expect(try decodeSession().subagents == nil)
    let session = try decodeSession(#"""
    , "subagents":[
      {"name":"review","state":"working","task":"Review the protocol","createdAt":1700000000000,"cwd":"/work","model":"test/model"},
      {"name":"docs","state":"idle","task":"Docs","createdAt":2,"cwd":"/work","lastAnswerId":"12","error":"model_error","retired":true}
    ]
    """#)
    let subagents = try #require(session.subagents)
    #expect(subagents.map(\.name) == ["review", "docs"])
    #expect(subagents[0].isWorking)
    #expect(subagents[0].model == "test/model")
    #expect(subagents[1].isFailed)
    #expect(!subagents[1].acceptsMessages)
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
}

@Test func displayStatePrefersWorkThenFailureThenUnreadAnswers() {
    let working = SessionSubagent(name: "a", state: .working, task: "", createdAt: 0, cwd: "/", lastAnswerId: "1", error: "x")
    let failed = SessionSubagent(name: "b", state: .idle, task: "", createdAt: 0, cwd: "/", lastAnswerId: "1", error: "x")
    let answered = SessionSubagent(name: "c", state: .idle, task: "", createdAt: 0, cwd: "/", lastAnswerId: "1")
    #expect(SubagentDisplayState(working, unread: true) == .working)
    #expect(SubagentDisplayState(failed, unread: true) == .failed)
    #expect(SubagentDisplayState(answered, unread: true) == .newAnswer)
    #expect(SubagentDisplayState(answered, unread: false) == .idle)
}

@Test func readStateTracksAnswerIdentityPerSessionAndRoundTrips() throws {
    var reads = SubagentReadState()
    let first = SessionSubagent(name: "review", state: .idle, task: "", createdAt: 0, cwd: "/", lastAnswerId: "10")
    let pending = SessionSubagent(name: "fresh", state: .working, task: "", createdAt: 0, cwd: "/")
    #expect(reads.isUnread(first, in: "s1"))
    #expect(!reads.isUnread(pending, in: "s1"), "no answer yet means nothing to read")
    #expect(reads.unreadCount([first, pending], in: "s1") == 1)
    let marked = reads.markRead(first, in: "s1")
    let markedAgain = reads.markRead(first, in: "s1")
    #expect(marked)
    #expect(!markedAgain)
    #expect(!reads.isUnread(first, in: "s1"))
    #expect(reads.isUnread(first, in: "s2"), "reads are per session")
    let next = SessionSubagent(name: "review", state: .idle, task: "", createdAt: 0, cwd: "/", lastAnswerId: "14")
    #expect(reads.isUnread(next, in: "s1"), "a new answer is unread again")
    let working = SessionSubagent(name: "review", state: .working, task: "", createdAt: 0, cwd: "/", lastAnswerId: "14")
    #expect(reads.unreadCount([working], in: "s1") == 0, "working subagents are not counted as new answers")
    let decoded = try JSONDecoder().decode(SubagentReadState.self, from: JSONEncoder().encode(reads))
    #expect(decoded == reads)
    reads.retain(sessions: ["s2"])
    #expect(reads.isUnread(first, in: "s1"))
}

@Test func notificationsParseExtensionAnswersAndFailures() throws {
    let answer = try #require(SubagentNotification(
        message: #"[subagent "code \"review\"] 1" answered, no reply needed] Found **two** gaps."#
    ))
    #expect(answer.name == #"code "review"] 1"#)
    #expect(!answer.failed)
    #expect(answer.text == "Found **two** gaps.")
    let failure = try #require(SubagentNotification(
        message: "[subagent \"tests\" failed, no reply needed] model_error: overloaded\n[Truncated.]"
    ))
    #expect(failure.failed)
    #expect(failure.text == "model_error: overloaded\n[Truncated.]")
    #expect(SubagentNotification(message: "Please look at [subagent \"x\" answered] this") == nil)
    #expect(SubagentNotification(message: "[subagent x answered] y") == nil)
    #expect(SubagentNotification(message: "[subagent \"x\" exploded] y") == nil)
    #expect(SubagentNotification(message: "[subagent \"unterminated") == nil)
}

@Test func transcriptsBuildFromOneShotSnapshots() throws {
    let events = try JSONDecoder().decode([JSONValue].self, from: Data(#"""
    [{"type":"snapshot","entries":[
      {"id":1,"kind":"pi.user","model":[{"role":"user","content":"Review the protocol"}]},
      {"id":2,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Two gaps."}]}]}
    ],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{"models":{},"tools":{}}}]
    """#.utf8))
    let rows = Transcript(events: events).rows
    #expect(rows.count == 2)
    if case let .user(_, text, _) = rows[0] { #expect(text == "Review the protocol") } else { Issue.record("expected user row") }
    if case let .text(_, text, _) = rows[1] { #expect(text == "Two gaps.") } else { Issue.record("expected text row") }
}
