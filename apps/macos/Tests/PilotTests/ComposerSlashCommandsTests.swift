import AppKit
import PilotCore
import Testing
@testable import Pilot

private func key(_ code: UInt16, _ characters: String) throws -> NSEvent {
    try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0,
                                 context: nil, characters: characters, charactersIgnoringModifiers: characters,
                                 isARepeat: false, keyCode: code))
}

@MainActor
private func editor() -> SubmitTextView {
    _ = NSApplication.shared
    let editor = SubmitTextView()
    editor.completionDirectory = nil
    editor.slashCommands = SlashCommands.all([SessionCommand(name: "review", source: .prompt)],
                                             app: SlashCommands.chatAppCommands(supportsChanges: true))
    return editor
}

@Test @MainActor func pickingAnAppCommandRunsItWithoutSending() throws {
    let editor = editor()
    var ran: [String] = []
    var submissions = 0
    editor.onAppCommand = { ran.append($0.name) }
    editor.onSubmit = { _ in submissions += 1 }
    editor.insertText("/term", replacementRange: editor.selectedRange())
    #expect(editor.completionPicker?.model.items.first?.id == "terminal")
    editor.keyDown(with: try key(36, "\r"))
    #expect(ran == ["terminal"])
    #expect(submissions == 0, "Return runs the command once and never also sends")
    #expect(editor.string.isEmpty)
    #expect(editor.completionPicker == nil)
}

@Test @MainActor func anAppCommandKeepsTheRestOfTheDraft() throws {
    let editor = editor()
    var ran: [String] = []
    editor.onAppCommand = { ran.append($0.name) }
    editor.onSubmit = { _ in Issue.record("must not submit") }
    editor.string = " keep this draft"
    editor.setSelectedRange(NSRange(location: 0, length: 0))
    editor.insertText("/chan", replacementRange: editor.selectedRange())
    editor.keyDown(with: try key(36, "\r"))
    #expect(ran == ["changes"])
    #expect(editor.string == "keep this draft")
    #expect(editor.selectedRange() == NSRange(location: 0, length: 0))
    // Undo brings the command text back as one edit, as any other edit.
    editor.undoManager?.undo()
}

@Test @MainActor func tabCompletesAnAppCommandWithoutRunningIt() throws {
    let editor = editor()
    var ran = 0
    editor.onAppCommand = { _ in ran += 1 }
    editor.insertText("/hel", replacementRange: editor.selectedRange())
    editor.keyDown(with: try key(48, "\t"))
    #expect(editor.string == "/help ")
    #expect(ran == 0)
}

@Test @MainActor func escapeClosesTheSlashMenuBeforeLeavingTheComposer() throws {
    let editor = editor()
    var cancellations = 0
    editor.onCancel = { cancellations += 1; return true }
    editor.insertText("/mod", replacementRange: editor.selectedRange())
    editor.keyDown(with: try key(53, "\u{1b}"))
    #expect(editor.completionPicker == nil)
    #expect(editor.string == "/mod")
    #expect(cancellations == 0)
    editor.keyDown(with: try key(53, "\u{1b}"))
    #expect(cancellations == 1, "the next Escape leaves the composer")
}
