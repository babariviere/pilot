import Foundation
import Testing
@testable import PilotCore

@Test func automaticUserEntriesRenderSeparatelyFromTypedMessages() async throws {
    let source = #"{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","model":[{"role":"user","timestamp":1,"content":"Typed"}]},{"id":2,"kind":"pi.user","origin":"mission","model":[{"role":"user","timestamp":2,"content":"Mission notice"}]},{"id":3,"kind":"pi.user","origin":"coordinator","model":[{"role":"user","timestamp":3,"content":"Coordinator note"}]},{"id":4,"kind":"pi.user","origin":"future-kind","model":[{"role":"user","content":"Unknown"}]}]}"#
    let result = try await TranscriptProcessor().apply([try JSONValue.decode(Data(source.utf8))])
    #expect(result.rows == [
        .user(id: "1-0", text: "Typed", timestamp: 1),
        .event(ChatEvent(id: "2-0", kind: "mission_updated", text: "Mission updated", timestamp: 2, detail: "Mission notice")),
        .automatic(id: "3-0", text: "Coordinator note", origin: .coordinator, timestamp: 3),
        .automatic(id: "4-0", text: "Unknown", origin: .extension),
    ])
}

@Test func coordinatorIdentityComesFromProvenanceAndSurvivesSnapshotReplay() async throws {
    let sender = "F8D1C654-6FF8-4D41-96E9-CEBD36A88C4A"
    let text = "From the Global coordinator: please fix it"
    let entry: JSONValue = .object([
        "id": .number(1), "kind": .string("pi.user"), "origin": .string("coordinator"),
        "sourceSessionId": .string(sender),
        "model": .array([.object(["role": .string("user"), "timestamp": .number(1), "content": .string(text)])]),
    ])
    let typed: JSONValue = .object([
        "id": .number(2), "kind": .string("pi.user"), "sourceSessionId": .string("not-provenance-without-origin"),
        "model": .array([.object(["role": .string("user"), "timestamp": .number(2), "content": .string(text)])]),
    ])
    let expected: [ChatRow] = [
        .event(ChatEvent(id: "1-0", kind: "coordinator_message", text: "Coordinator (F8D1C654) wrote",
                         title: text, timestamp: 1, detail: "From chat \(sender)\n\n\(text)")),
        .user(id: "2-0", text: text, timestamp: 2),
    ]
    let live = TranscriptProcessor()
    let liveResult = try await live.apply([
        .object(["type": .string("message_end"), "entry": entry]),
        .object(["type": .string("message_end"), "entry": typed]),
    ])
    #expect(liveResult.rows == expected)
    let snapshot: JSONValue = .object(["type": .string("snapshot"), "entries": .array([entry, typed])])
    let reopened = try await TranscriptProcessor().apply([snapshot])
    #expect(reopened.rows == expected)
}
