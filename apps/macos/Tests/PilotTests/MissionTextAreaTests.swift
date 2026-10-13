import AppKit
import Testing
@testable import Pilot

private func returnKey(_ flags: NSEvent.ModifierFlags = []) throws -> NSEvent {
    try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                 windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
                                 isARepeat: false, keyCode: 36))
}

@Test @MainActor func formEditorReturnInsertsNewlineAndCommandReturnSubmits() throws {
    _ = NSApplication.shared
    let editor = SubmitTextView()
    editor.returnInsertsNewline = true
    var submissions = 0
    editor.onSubmit = { _ in submissions += 1 }
    editor.string = "a"
    editor.setSelectedRange(NSRange(location: 1, length: 0))
    editor.keyDown(with: try returnKey())
    #expect(submissions == 0)
    #expect(editor.string == "a\n")
    editor.keyDown(with: try returnKey(.shift))
    #expect(submissions == 0)
    #expect(editor.string == "a\n\n")
    editor.keyDown(with: try returnKey(.command))
    #expect(submissions == 1)
    #expect(editor.string == "a\n\n")
}

@Test @MainActor func chatEditorKeepsReturnSubmitting() throws {
    _ = NSApplication.shared
    let editor = SubmitTextView()
    var submissions = 0
    editor.onSubmit = { _ in submissions += 1 }
    editor.keyDown(with: try returnKey())
    #expect(submissions == 1)
    #expect(editor.string.isEmpty)
}
