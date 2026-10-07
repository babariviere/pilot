import Foundation
import Testing
@testable import PilotCore

private func todoJSON(_ text: String) -> JSONValue {
    try! JSONValue.decode(Data(text.utf8))
}

@Test func todoUpdatesReplaceStateAndSurviveAgentSnapshots() async throws {
    var transcript = Transcript()
    let update = todoJSON(#"{"type":"todos_update","items":[{"id":"TODO-deadbeef","title":"Add tests","status":"open","createdAt":"2026-07-01","assignedToSession":"mine"}]}"#)
    transcript.apply(update)
    #expect(transcript.todos.first?.title == "Add tests")
    #expect(transcript.todos.first?.isWorking(in: "mine") == true)
    #expect(transcript.todos.first?.isWorking(in: "other") == false)
    transcript.apply(todoJSON(#"{"type":"snapshot","entries":[],"tools":[]}"#))
    #expect(transcript.todos.count == 1)
    #expect(TranscriptPresentation(transcript: transcript).todos == transcript.todos)

    let processor = TranscriptProcessor()
    let first = try await processor.apply([update])
    let duplicate = try await processor.apply([update])
    #expect(first.revision == duplicate.revision)
    let cleared = try await processor.apply([todoJSON(#"{"type":"todos_update","items":[]}"#)])
    #expect(cleared.todos.isEmpty)
    #expect(cleared.revision > first.revision)
}

@Test func todoOrderingPutsCurrentWorkBeforeOpenAndCompletedTasks() {
    let values = todoJSON(#"""
    [
      {"id":"TODO-00000001","title":"Done","status":"DONE","createdAt":"1","assignedToSession":"mine"},
      {"id":"TODO-00000002","title":"Open","status":"open","createdAt":"2"},
      {"id":"TODO-00000003","title":"Other work","status":"open","createdAt":"3","assignedToSession":"other"},
      {"id":"TODO-00000004","title":"My work","status":"open","createdAt":"4","assignedToSession":"mine"},
      {"id":"TODO-00000005","title":"Closed","status":"closed","createdAt":"5"},
      {"id":42,"title":"Malformed"}
    ]
    """#)
    let todos = (values.array ?? []).compactMap(SessionTodo.init(json:))
    #expect(todos.count == 5)
    #expect(todos.inDisplayOrder(for: "mine").map(\.title) == ["My work", "Open", "Other work", "Done", "Closed"])
    #expect(todos[0].isClosed)
    #expect(!todos[0].isWorking(in: "mine"))
}
