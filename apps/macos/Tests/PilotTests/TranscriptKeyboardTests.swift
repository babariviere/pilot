import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func transcriptMovementStartsAtTheLatestRowAndStopsAtTheEnds() {
    let ids = ["a", "b", "c"]
    #expect(TranscriptKeyboard.next(from: nil, by: -1, in: ids) == "c", "entering from the composer")
    #expect(TranscriptKeyboard.next(from: nil, by: 1, in: ids) == "c")
    #expect(TranscriptKeyboard.next(from: "gone", by: -1, in: ids) == "c", "a row that left falls back to the latest")
    #expect(TranscriptKeyboard.next(from: "c", by: -1, in: ids) == "b")
    #expect(TranscriptKeyboard.next(from: "a", by: -1, in: ids) == nil, "the top asks for earlier history instead")
    #expect(TranscriptKeyboard.next(from: "c", by: 1, in: ids) == nil)
    #expect(TranscriptKeyboard.next(from: nil, by: 1, in: []) == nil)
}

@Test @MainActor func onlyMessagesAreCopiedFromTheTranscript() {
    #expect(TranscriptKeyboard.copyText(.user(id: "u", text: "Please fix it", timestamp: nil)) == "Please fix it")
    #expect(TranscriptKeyboard.copyText(.text(id: "t", text: "Done.", timestamp: nil)) == "Done.")
    #expect(TranscriptKeyboard.copyText(.error(id: "e", text: "boom")) == nil)
    #expect(TranscriptKeyboard.copyText(.notice(id: "n", text: "Compacted")) == nil)
}
