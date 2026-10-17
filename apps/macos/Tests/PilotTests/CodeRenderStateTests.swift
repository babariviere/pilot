import Foundation
import Testing
@testable import Pilot

@MainActor
struct CodeRenderStateTests {
    @Test func completeToolInputReplacesHighlightedPrefixBeforePreparation() async throws {
        let state = CodeRenderState()
        let prefix = "text(await tools.applyPatch({patch:"
        // A patch encoded as a JS string is one long line, as in the reported tool call.
        let patch = String(repeating: "*** Update File: Example.swift\\n+let café = true\\n", count: 1500)
        let source = prefix + "\"*** Begin Patch\\n" + patch + "*** End Patch\"}));"
        #expect(String(state.text(for: source, language: "javascript").characters) == source)

        try await state.prepare(prefix, language: "javascript")
        #expect(String(state.text(for: prefix, language: "javascript").characters) == prefix)
        // No task needs to start or finish before the expanded row shows the complete input.
        let immediate = state.text(for: source, language: "javascript")
        #expect(immediate == AttributedString(source))
        #expect(String(immediate.characters).hasSuffix("*** End Patch\"}));"))

        try await state.prepare(source, language: "javascript")
        let highlighted = state.text(for: source, language: "javascript")
        #expect(String(highlighted.characters) == source)
        #expect(highlighted != AttributedString(source))
    }

    @Test func replacementAndLanguageChangesDoNotReuseEarlierHighlighting() async throws {
        let state = CodeRenderState()
        let source = "const answer = 42;"
        try await state.prepare(source, language: "javascript")
        #expect(state.text(for: source, language: "javascript") != AttributedString(source))
        for replacement in ["", "const", "const answer = 43;", "different input\nwith more lines"] {
            #expect(state.text(for: replacement, language: "javascript") == AttributedString(replacement))
        }
        #expect(state.text(for: source, language: nil) == AttributedString(source))
        try await state.prepare(source, language: nil)
        let plain = try await MarkdownRenderer.shared.prepareCode(source, language: nil)
        #expect(state.text(for: source, language: nil) == plain)
        #expect(state.text(for: source, language: "javascript") == AttributedString(source))
    }

    @Test func cancelledHighlightingCannotLeaveTheCurrentInputTruncated() async throws {
        let state = CodeRenderState()
        let prefix = "text(await tools.read("
        let source = prefix + "{path: 'Example.swift'}));"
        try await state.prepare(prefix, language: "javascript")
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await state.prepare(source, language: "javascript")
        }
        do {
            try await task.value
            Issue.record("Expected highlighting to be cancelled")
        } catch is CancellationError {
            #expect(state.text(for: source, language: "javascript") == AttributedString(source))
        }
    }
}
