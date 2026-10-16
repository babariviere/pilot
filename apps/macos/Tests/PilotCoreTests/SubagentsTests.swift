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

@Test func subagentConfigurationUsesItsOwnSnapshotAndSurvivesIncrementalEntries() throws {
    let events = try JSONDecoder().decode([JSONValue].self, from: Data(#"""
    [{"type":"snapshot","agent":{"model":{"provider":"test","modelId":"child-model"},"thinkingLevel":"xhigh"}}]
    """#.utf8))
    var configuration = SubagentConfiguration()
    configuration.apply(events)
    #expect(configuration.model == "test/child-model")
    #expect(configuration.thinking == "xhigh")
    #expect(configuration.thinkingLabel == "Thinking: XHigh")
    configuration.apply([.object(["type": .string("entry_appended")])])
    #expect(configuration.model == "test/child-model")
    #expect(configuration.thinking == "xhigh")
    configuration.apply([.object(["type": .string("snapshot"), "agent": .object([:])])])
    #expect(configuration.model == nil)
    #expect(configuration.thinking == nil)
    #expect(configuration.thinkingLabel == "Thinking not reported")
}

@Test func subagentConfigurationDistinguishesThinkingOffFromUnreported() throws {
    var configuration = SubagentConfiguration()
    #expect(configuration.thinkingLabel == "Thinking not reported")
    for (level, label) in [("off", "Off"), ("high", "High"), ("", "")] {
        let events = try JSONDecoder().decode([JSONValue].self, from: Data("""
        [{"type":"snapshot","agent":{"model":{"provider":"test"},"thinkingLevel":"\(level)"}}]
        """.utf8))
        configuration.apply(events)
        #expect(configuration.model == nil, "Incomplete model references are not displayed")
        #expect(configuration.thinkingLabel == (level.isEmpty ? "Thinking not reported" : "Thinking: \(label)"))
    }
}

@Test func displayStatePrefersWorkThenFailureThenDone() {
    let working = SessionSubagent(name: "a", state: .working, task: "", createdAt: 0, cwd: "/", lastAnswerId: "1", error: "x")
    let failed = SessionSubagent(name: "b", state: .idle, task: "", createdAt: 0, cwd: "/", lastAnswerId: "1", error: "x")
    let answered = SessionSubagent(name: "c", state: .idle, task: "", createdAt: 0, cwd: "/", lastAnswerId: "1")
    let fresh = SessionSubagent(name: "d", state: .idle, task: "", createdAt: 0, cwd: "/")
    #expect(SubagentDisplayState(working) == .working)
    #expect(SubagentDisplayState(failed) == .failed)
    #expect(SubagentDisplayState(answered) == .done, "a finished answer is for the parent chat, not the user")
    #expect(SubagentDisplayState(fresh) == .done)
    #expect(SubagentDisplayState(answered).label == "Done")
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
