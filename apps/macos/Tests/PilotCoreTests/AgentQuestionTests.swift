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

@Test func backgroundJobsDoNotHideTheQuestionComposer() throws {
    let presentation = try TranscriptPresentation(transcript: transcript([userInput, askCall, askResult, questionEntry]))
    let question = try #require(presentation.pendingQuestion)
    let jobs = [SessionJob(id: "tests", name: "Tests", startedAt: 1, outputPath: "/tmp/tests.log")]
    // Both current summaries and legacy summaries without the derived working flag report busy jobs.
    for working: Bool? in [true, nil] {
        let session = SessionSummary(id: "chat", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 1,
                                     state: "idle", runningJobs: jobs, working: working)
        #expect(session.isWorking)
        #expect(presentation.questionForComposer(session: session, hasSnapshot: true) == question)
        #expect(presentation.questionForComposer(session: session, hasSnapshot: false) == nil)

        var active = presentation
        active.working = true
        #expect(active.questionForComposer(session: session, hasSnapshot: true) == nil)

        let reply = #"{"id":5,"kind":"pi.user","model":[{"role":"user","content":"Sync worker"}]}"#
        let answered = try TranscriptPresentation(transcript: transcript([questionEntry, reply]))
        #expect(answered.questionForComposer(session: session, hasSnapshot: true) == nil)
    }
}

@Test func questionComposerWaitsForTheActiveTurnAcrossBothFeeds() throws {
    let presentation = try TranscriptPresentation(transcript: transcript([questionEntry]))
    for state in ["starting", "working", "idle", "parked"] {
        let session = SessionSummary(id: "chat", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 1,
                                     state: state, working: true)
        let expected = state == "idle" || state == "parked" ? presentation.pendingQuestion : nil
        #expect(presentation.questionForComposer(session: session, hasSnapshot: true) == expected)
    }
}

@Test func awaitedQuestionsShowWhileTheirRunWorksLegacyAndAccessDoNot() throws {
    let awaited = #"{"id":4,"kind":"pilot.question","data":{"question":"Where should retries live?","options":[{"label":"Shared client"}],"blocking":true},"model":[]}"#
    let access = #"{"id":4,"kind":"pilot.question","data":{"question":"Allow?","options":[{"label":"Allow"},{"label":"Deny"}],"blocking":true,"databaseAccess":{"id":"r","env":"prod","mode":"read"}},"model":[]}"#
    let malformed = #"{"id":4,"kind":"pilot.question","data":{"question":"Where should retries live?","blocking":"true"},"model":[]}"#
    let legacy = try #require(try transcript([questionEntry]).pendingQuestion)
    #expect(!legacy.blocking)
    #expect(try #require(try transcript([awaited]).pendingQuestion).blocking)
    #expect(try #require(try transcript([access]).pendingQuestion).blocking == false)
    #expect(try #require(try transcript([malformed]).pendingQuestion).blocking == false)
    for (entry, showsWhileWorking) in [(awaited, true), (questionEntry, false), (access, false), (malformed, false)] {
        let presentation = try TranscriptPresentation(transcript: transcript([entry]))
        let question = try #require(presentation.pendingQuestion)
        for state in ["starting", "working", "idle"] {
            let session = SessionSummary(id: "chat", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 1,
                                         state: state, working: state != "idle")
            let expected = state == "idle" || (state == "working" && showsWhileWorking) ? question : nil
            #expect(presentation.questionForComposer(session: session, hasSnapshot: true) == expected)
        }
        var active = presentation
        active.working = true
        let idle = SessionSummary(id: "chat", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle")
        #expect(active.questionForComposer(session: idle, hasSnapshot: true) == (showsWhileWorking ? question : nil))
        #expect(active.questionForComposer(session: idle, hasSnapshot: false) == nil)
    }
    // The ordinary reply entry answers it, even while the run continues.
    let reply = #"{"id":5,"kind":"pi.user","model":[{"role":"user","content":"Shared client"}]}"#
    var answered = try TranscriptPresentation(transcript: transcript([awaited, reply]))
    answered.working = true
    let working = SessionSummary(id: "chat", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "working")
    #expect(answered.questionForComposer(session: working, hasSnapshot: true) == nil)
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

@Test func databaseAccessQuestionsCarryTheirRequestAndStaySingleChoice() throws {
    let entry = #"{"id":4,"kind":"pilot.question","data":{"question":"Allow read access to the prod database?","options":[{"label":"Allow read access to prod"},{"label":"Deny"}],"multiSelect":true,"databaseAccess":{"id":"request-1","env":"prod","mode":"read"}},"model":[]}"#
    let question = try #require(try transcript([userInput, entry]).pendingQuestion)
    #expect(question.databaseAccess == AgentQuestion.DatabaseAccess(id: "request-1", env: "prod", mode: "read"))
    #expect(question.multiSelect == false)
    // Ordinary questions, or a request without an id, have no access request.
    #expect(try transcript([userInput, questionEntry]).pendingQuestion?.databaseAccess == nil)
    let noID = #"{"id":4,"kind":"pilot.question","data":{"question":"Allow?","options":[],"databaseAccess":{"env":"prod","mode":"read"}},"model":[]}"#
    #expect(try transcript([userInput, noID]).pendingQuestion?.databaseAccess == nil)
}
