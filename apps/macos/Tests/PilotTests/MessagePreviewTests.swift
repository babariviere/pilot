import PilotCore
import Testing
@testable import Pilot

@Test func shortMessagePreviewPreservesSource() {
    for source in ["", "Hello", "# Heading\n\n**bold**", "a\r\nb"] {
        let preview = MessagePreview(source)
        #expect(!preview.isLong)
        #expect(preview.text == source)
    }
}

@Test func longMessageThresholdsCoverCharactersAndLines() {
    #expect(!MessagePreview(String(repeating: "a", count: 1600)).isLong)
    #expect(MessagePreview(String(repeating: "a", count: 1601)).isLong)
    #expect(!MessagePreview(String(repeating: "a\n", count: 15) + "a").isLong)
    #expect(MessagePreview(String(repeating: "a\n", count: 16) + "a").isLong)
    #expect(MessagePreview(String(repeating: "a\r\n", count: 16) + "a").isLong)
}

@Test func crashReportPreviewIsBoundedAndUnicodeSafe() {
    let report = "I had a crash:\n\n" + String(repeating: "SwiftUI menu frame\n", count: 4000)
    let preview = MessagePreview(report)
    #expect(preview.isLong)
    #expect(preview.text.hasPrefix("I had a crash:"))
    #expect(preview.text.count <= MessagePreview.previewCharacterLimit)
    #expect(preview.text.split(separator: "\n", omittingEmptySubsequences: false).count <= MessagePreview.previewLineLimit)
    let emoji = "👩🏽‍💻"
    let emojiSource = String(repeating: emoji, count: 2000)
    let emojiPreview = MessagePreview(emojiSource)
    #expect(emojiPreview.isLong && emojiSource.hasPrefix(emojiPreview.text))
    #expect(emojiPreview.text.utf8.count <= MessagePreview.previewByteLimit)
    #expect(emojiPreview.text.hasSuffix(emoji))
    #expect(MessagePreview(String(repeating: "x", count: 1_000_000)).text.count == 800)
}

@Test func pathologicalCombiningGraphemeCannotBypassPreviewBounds() {
    let source = "a" + String(repeating: "\u{0301}", count: 1_000_000)
    let preview = MessagePreview(source)
    #expect(preview.isLong)
    #expect(preview.text.utf8.count <= MessagePreview.previewByteLimit)
}

@Test @MainActor func streamedMessageExpansionTransfersWithoutLeakingToNextMessage() {
    let owner = TranscriptExpansions()
    owner.applyMessageEvents([.object(["type": .string("message_start")])])
    let generation = owner.streamingGeneration
    let expanded = owner.state(for: "streaming-0")
    expanded.expanded = true
    // Ordered batch hides the intermediate non-streaming state from ChatView.
    owner.applyMessageEvents([
        .object(["type": .string("message_end"), "entry": .object([
            "id": .number(42), "kind": .string("pi.assistant"),
            "model": .array([.object(["role": .string("assistant"), "content": .string("Final response")])]),
        ])]),
        .object(["type": .string("message_start")]),
    ])
    #expect(owner.state(for: "42-0-0") === expanded)
    #expect(owner.state(for: "42-0-0").expanded)
    #expect(owner.streamingGeneration != generation)
    #expect(owner.state(for: "streaming-0") !== expanded)
    #expect(!owner.state(for: "streaming-0").expanded)
}

@Test @MainActor func messageExpansionsAreIsolatedAndStable() {
    let owner = TranscriptExpansions()
    let first = owner.state(for: "7-0")
    first.expanded = true
    #expect(owner.state(for: "7-0") === first)
    #expect(owner.state(for: "7-0").expanded)
    #expect(!owner.state(for: "8-0").expanded)
    #expect(!TranscriptExpansions().state(for: "7-0").expanded)
}

@Test @MainActor func recoverySnapshotsPreserveAndReconcileStreamedExpansion() {
    let owner = TranscriptExpansions()
    let message: JSONValue = .object([
        "role": .string("assistant"), "timestamp": .number(123), "content": .string("response"),
    ])
    owner.applyMessageEvents([.object(["type": .string("message_start"), "message": message])])
    let expanded = owner.state(for: "streaming-0")
    expanded.expanded = true
    let generation = owner.streamingGeneration
    owner.applyMessageEvents([.object([
        "type": .string("snapshot"), "generation": .object(["message": message]),
    ])])
    #expect(owner.streamingGeneration == generation)
    #expect(owner.state(for: "streaming-0") === expanded)
    owner.applyMessageEvents([.object([
        "type": .string("snapshot"), "entries": .array([.object([
            "id": .number(99), "kind": .string("pi.assistant"), "model": .array([message]),
        ])]),
        "generation": .object(["message": .object([
            "role": .string("assistant"), "timestamp": .number(456), "content": .string("next response"),
        ])]),
    ])])
    #expect(owner.state(for: "99-0-0") === expanded)
    #expect(owner.state(for: "99-0-0").expanded)
    #expect(owner.streamingGeneration != generation)
    #expect(!owner.state(for: "streaming-0").expanded)
}
