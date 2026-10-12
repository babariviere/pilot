import Foundation
import Testing
@testable import PilotCore

@Test func automaticUserEntriesRenderSeparatelyFromTypedMessages() async throws {
    let source = #"{"type":"snapshot","entries":[{"id":1,"kind":"pi.user","model":[{"role":"user","timestamp":1,"content":"Typed"}]},{"id":2,"kind":"pi.user","origin":"mission","model":[{"role":"user","timestamp":2,"content":"Coordinator note"}]},{"id":3,"kind":"pi.user","origin":"future-kind","model":[{"role":"user","content":"Unknown"}]}]}"#
    let result = try await TranscriptProcessor().apply([try JSONValue.decode(Data(source.utf8))])
    #expect(result.rows == [
        .user(id: "1-0", text: "Typed", timestamp: 1),
        .automatic(id: "2-0", text: "Coordinator note", origin: .mission, timestamp: 2),
        .automatic(id: "3-0", text: "Unknown", origin: .extension),
    ])
}
