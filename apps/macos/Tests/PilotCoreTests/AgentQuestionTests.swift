import Foundation
import Testing
@testable import PilotCore

private let askCall = #"{"id":2,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"q","name":"ask_user","arguments":{"question":"Where?"}}]}]}"#
private let askResult = #"{"id":3,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"q","content":[{"type":"text","text":"asked"}],"isError":false}]}"#
private let questionEntry = #"{"id":4,"kind":"pilot.question","data":{"question":" Where should retries live? ","context":"Only the worker needs them.","options":[{"label":"Shared client","detail":"Every caller","suggested":true},{"label":"Sync worker"},{"label":" "}]},"model":[]}"#
private let userInput = #"{"id":1,"kind":"pi.user","model":[{"role":"user","content":"Add retries"}]}"#
// The summary is newer than the retained question and carries a synthetic user message.
private let compaction = #"{"id":8,"kind":"pi.compaction","head":2,"data":{"reason":"manual"},"model":[{"role":"user","content":[{"type":"text","text":"Compacted history summary"}]}]}"#

private func snapshot(_ entries: [String], working: Bool = false) throws -> JSONValue {
    let run = working ? #","run":{"id":1}"# : ""
    let event = #"{"type":"snapshot","entries":["# + entries.joined(separator: ",") + #"],"tools":[],"inbox":[]"# + run + "}"
    return try JSONValue.decode(Data(event.utf8))
}

private func transcript(_ entries: [String], working: Bool = false) throws -> Transcript {
    var transcript = Transcript()
    transcript.apply(try snapshot(entries, working: working))
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

@Test func compactionDoesNotAnswerAPendingQuestion() async throws {
    let entries = [askCall, askResult, questionEntry]
    let expected = try #require(transcript(entries).pendingQuestion)

    // Reopening receives the head marker first, then the retained entries. The reducer sorts by ID.
    let reopened = try transcript([compaction] + entries)
    #expect(reopened.pendingQuestion == expected)
    #expect(TranscriptPresentation(transcript: reopened).pendingQuestion == expected)

    // A live compaction updates both the transcript and its cached presentation.
    let compacted = try JSONValue.decode(Data((#"{"type":"entry_appended","entry":"# + compaction + "}").utf8))
    var live = try transcript(entries)
    live.apply(compacted)
    #expect(live.pendingQuestion == expected)
    let processor = TranscriptProcessor()
    #expect(try await processor.apply([snapshot(entries)]).pendingQuestion == expected)
    #expect(try await processor.apply([compacted]).pendingQuestion == expected)
    #expect(try await processor.apply([snapshot([compaction] + entries)]).pendingQuestion == expected)

    // A real reply still answers the question, including when it precedes a later compaction.
    let reply = #"{"id":7,"kind":"pi.user","model":[{"role":"user","content":"Sync worker"}]}"#
    #expect(try transcript([compaction] + entries + [reply]).pendingQuestion == nil)
    let automatic = #"{"id":7,"kind":"pilot.activity","model":[{"role":"user","content":"Continue"}]}"#
    #expect(try transcript([compaction] + entries + [automatic]).pendingQuestion == nil)
    let after = #"{"id":9,"kind":"pi.user","model":[{"role":"user","content":"Sync worker"}]}"#
    let answered = try JSONValue.decode(Data((#"{"type":"entry_appended","entry":"# + after + "}").utf8))
    #expect(try await processor.apply([answered]).pendingQuestion == nil)
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
    guard case let .tools(_, items) = failedRows.last?.unfolded.last else { Issue.record("expected the tool card"); return }
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
