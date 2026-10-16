import Foundation
import Testing
@testable import PilotCore

@Test func transcriptStatusStaysEqualWhileTextStreams() async throws {
    let processor = TranscriptProcessor()
    func event(_ json: String) throws -> JSONValue { try JSONValue.decode(Data(json.utf8)) }
    _ = try await processor.apply([
        try event(#"{"type":"snapshot","entries":[],"run":{}}"#),
        try event(#"{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}"#),
    ])
    let first = try await processor.apply([
        try event(#"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":" there"}]}"#),
    ])
    let second = try await processor.apply([
        try event(#"{"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":", more"}]}"#),
    ])
    #expect(first.rows != second.rows)
    #expect(TranscriptStatus(first) == TranscriptStatus(second))
    #expect(TranscriptStatus(second).working && TranscriptStatus(second).streaming)
    let ended = try await processor.apply([try event(#"{"type":"run_end"}"#)])
    #expect(TranscriptStatus(ended) != TranscriptStatus(second))
}

@Test func transcriptStatusMatchesThePresentationItSummarizes() {
    var presentation = TranscriptPresentation()
    presentation.rows = [.user(id: "1-0", text: "Do it"), .error(id: "2-error", text: "Model failed")]
    let status = TranscriptStatus(presentation)
    #expect(status.hasRows)
    #expect(status.retryEntryID == presentation.retryEntryID)
    #expect(status.retryEntryID == 2)
    #expect(status.lastErrorText == "Model failed")
    #expect(!TranscriptStatus(TranscriptPresentation()).hasRows)
}
