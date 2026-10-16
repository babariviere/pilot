import Foundation
import Testing
@testable import PilotCore

private func json(_ text: String) -> JSONValue {
    try! JSONValue.decode(Data(text.utf8))
}

private func transcript(_ entries: String, working: Bool = false) -> TranscriptPresentation {
    var transcript = Transcript()
    let run = working ? #","run":{"inputs":[]}"# : ""
    transcript.apply(json(#"{"type":"snapshot","entries":["# + entries + #"],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}"# + run + "}"))
    return TranscriptPresentation(transcript: transcript)
}

private let user = #"{"id":3,"conversationId":1,"kind":"pi.user","model":[{"role":"user","content":"Fix the test"}]}"#
private let reply = #"{"id":5,"conversationId":1,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Done"}]}]}"#
private let failure = #"{"id":9,"conversationId":7,"kind":"pi.assistant","model":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"overloaded_error"}]}"#

@Test func committedRowsOfferEditRestoreAndRetryForTheirEntries() {
    let rows = transcript([user, reply, failure].joined(separator: ",")).rows
    #expect(rows.map(\.entryID) == [3, 5, 9])
    #expect(rows.map(\.rewindAction) == [.edit, .restore, .retry])
    #expect(ChatRow.error(id: "transcript-error", text: "Task failed").entryID == nil)
    #expect(ChatRow.text(id: "streaming-0", text: "partial").rewindAction == nil)
    let automatic = ChatRow.automatic(id: "4-0", text: "Job finished", origin: .job)
    #expect(automatic.entryID == 4)
    #expect(automatic.rewindAction == nil, "only messages the user typed can be edited")
}

@Test func onlyAnIdleTrailingFailureCanBeRetried() {
    #expect(transcript([user, failure].joined(separator: ",")).retryEntryID == 9)
    #expect(transcript([user, failure].joined(separator: ","), working: true).retryEntryID == nil)
    let earlier = failure.replacingOccurrences(of: #""id":9"#, with: #""id":2"#)
    #expect(transcript([earlier, user, reply].joined(separator: ",")).retryEntryID == nil,
            "an earlier failure is handled by restore or edit, not retry")
    #expect(transcript(user).retryEntryID == nil)
}

@Test func decodesAttemptsAndLabelsThem() throws {
    let data = Data(#"""
    {"id":"s","title":"Chat","cwd":"/repo","createdAt":1,"updatedAt":2,"state":"idle","attempts":[
      {"id":"1"},
      {"id":"7","reason":"retry","createdAt":1700000000000,"preview":"Fix the test"},
      {"id":"9","reason":"edit","createdAt":1700000001000,"preview":"Fix the flaky login test, then\nrun it","active":true},
      {"id":"10","reason":"model","preview":"anthropic/claude-opus"},
      {"id":"11","reason":"future"}
    ]}
    """#.utf8)
    let session = try JSONDecoder().decode(SessionSummary.self, from: data)
    let attempts = try #require(session.attempts)
    #expect(attempts.map(\.title) == ["Original", "Retry", "Edited: Fix the flaky login test, then", "Model changed", "Original"])
    #expect(attempts.last?.reason == nil, "unknown actions from newer daemons still decode")
    #expect(attempts.filter(\.isActive).map(\.id) == ["9"])
    #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(session)) == session)
    let older = try JSONDecoder().decode(SessionSummary.self, from: Data(#"{"id":"s","title":"Chat","cwd":"/repo","createdAt":1,"updatedAt":2,"state":"idle"}"#.utf8))
    #expect(older.attempts == nil)
}
