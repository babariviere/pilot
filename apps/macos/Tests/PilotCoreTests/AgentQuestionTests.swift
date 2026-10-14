import Foundation
import Testing
@testable import PilotCore

private let askCall = #"{"id":2,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"q","name":"ask_user","arguments":{"question":"Where?"}}]}]}"#
private let askResult = #"{"id":3,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"q","content":[{"type":"text","text":"asked"}],"isError":false}]}"#
private let questionEntry = #"{"id":4,"kind":"pilot.question","data":{"question":" Where should retries live? ","context":"Only the worker needs them.","options":[{"label":"Shared client","detail":"Every caller","suggested":true},{"label":"Sync worker"},{"label":" "}]},"model":[]}"#
private let userInput = #"{"id":1,"kind":"pi.user","model":[{"role":"user","content":"Add retries"}]}"#

private func transcript(_ entries: [String], working: Bool = false) throws -> Transcript {
    var transcript = Transcript()
    let run = working ? #","run":{"id":1}"# : ""
    let snapshot = #"{"type":"snapshot","entries":["# + entries.joined(separator: ",") + #"],"tools":[],"inbox":[]"# + run + "}"
    transcript.apply(try JSONValue.decode(Data(snapshot.utf8)))
    return transcript
}

@Test func questionEntryParsesAndIsPendingUntilAUserMessage() throws {
    let asked = try transcript([userInput, askCall, askResult, questionEntry])
    let question = try #require(asked.pendingQuestion)
    #expect(question == AgentQuestion(
        entryID: 4, question: "Where should retries live?", context: "Only the worker needs them.",
        options: [.init(label: "Shared client", detail: "Every caller", suggested: true), .init(label: "Sync worker")]
    ))
    #expect(TranscriptPresentation(transcript: asked).pendingQuestion == question)

    let reply = #"{"id":5,"kind":"pi.user","model":[{"role":"user","content":"Sync worker"}]}"#
    #expect(try transcript([userInput, askCall, askResult, questionEntry, reply]).pendingQuestion == nil)
    // An answered question stays answered after the agent continues.
    let after = #"{"id":6,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"Done."}]}]}"#
    #expect(try transcript([userInput, askCall, askResult, questionEntry, reply, after]).pendingQuestion == nil)
    // A later assistant message does not hide a question no one answered.
    #expect(try transcript([userInput, askCall, askResult, questionEntry, after]).pendingQuestion?.entryID == 4)
}

@Test func recordedQuestionReplacesTheToolCard() throws {
    let rows = try transcript([userInput, askCall, askResult, questionEntry]).rows
    #expect(rows.count == 2)
    guard case let .question(id, question) = rows[1] else { Issue.record("expected a question row"); return }
    #expect(id == "4-question")
    #expect(question.question == "Where should retries live?")

    // A failed call keeps its tool card, since no question was recorded.
    let failed = #"{"id":3,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"q","content":[{"type":"text","text":"bad"}],"isError":true}]}"#
    let failedRows = try transcript([userInput, askCall, failed]).rows
    guard case let .tools(_, items) = failedRows.last else { Issue.record("expected the tool card"); return }
    #expect(items.map(\.status) == [.error])
}

@Test func questionReplyCombinesPickedAnswersAndOwnWords() {
    let question = AgentQuestion(entryID: 1, question: "Which checks?",
                                 options: [.init(label: "Typecheck"), .init(label: "Tests"), .init(label: "Build")],
                                 multiSelect: true)
    #expect(question.reply(selected: [], text: "  ") == nil)
    #expect(question.reply(selected: [1], text: "") == "Tests")
    #expect(question.reply(selected: [2, 0], text: "") == "- Typecheck\n- Build")
    #expect(question.reply(selected: [0], text: " Skip the slow ones ") == "Typecheck\n\nSkip the slow ones")
    #expect(question.reply(selected: [7], text: "") == nil)
    #expect(AgentQuestion(entryID: 1, question: "Proceed?", options: [.init(label: "Yes")], multiSelect: true).multiSelect == false)
}
