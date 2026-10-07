import AppKit
import Testing
@testable import Pilot

private final class EditObserver: NSObject, NSTextViewDelegate {
    var changes = 0
    func textDidChange(_ notification: Notification) { changes += 1 }
}

private final class CompletionCommand: NSObject, NSTextViewDelegate {
    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard commandSelector == #selector(NSTextView.insertNewline(_:)) else { return false }
        textView.insertCompletion("README.md", forPartialWordRange: NSRange(location: 5, length: 1),
                                  movement: NSTextMovement.return.rawValue, isFinal: true)
        return true
    }
}

@Test @MainActor func returnHandledByCompletionDoesNotAlsoSubmit() throws {
    _ = NSApplication.shared
    let editor = SubmitTextView()
    let completion = CompletionCommand()
    editor.delegate = completion
    editor.string = "Read R"
    editor.setSelectedRange(NSRange(location: 6, length: 0))
    var submissions = 0
    editor.onSubmit = { _ in submissions += 1 }
    let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                                            timestamp: 0, windowNumber: 0, context: nil,
                                            characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
    editor.keyDown(with: event)
    #expect(editor.string == "Read README.md")
    #expect(submissions == 0)
    editor.delegate = nil
    editor.keyDown(with: event)
    #expect(submissions == 1)
}

@Test @MainActor func tabCompletesPathsAndNotifiesTheBinding() throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try Data().write(to: directory.appendingPathComponent("README.md"))
    let editor = SubmitTextView()
    let observer = EditObserver()
    editor.delegate = observer
    editor.isRichText = false
    editor.allowsUndo = true
    editor.completionDirectory = directory.path
    editor.string = "Read REA"
    editor.setSelectedRange(NSRange(location: 8, length: 0))
    editor.insertTab(nil)
    #expect(editor.string == "Read README.md")
    #expect(editor.selectedRange().location == 14)
    #expect(observer.changes > 0)
    editor.string = "Read `REA` later"
    editor.setSelectedRange(NSRange(location: 9, length: 0))
    editor.insertTab(nil)
    #expect(editor.string == "Read `README.md` later")
    editor.string = "no-match"
    editor.setSelectedRange(NSRange(location: 8, length: 0))
    editor.insertTab(nil)
    #expect(editor.string == "no-match\t")
}

@Test @MainActor func returnShortcutsStillSubmitOrInsertALine() throws {
    _ = NSApplication.shared
    let editor = SubmitTextView()
    var submissions: [NSEvent.ModifierFlags] = []
    editor.onSubmit = { submissions.append($0) }
    for flags: NSEvent.ModifierFlags in [[], .option, .shift, .control, .command] {
        let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                                                timestamp: 0, windowNumber: 0, context: nil,
                                                characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        editor.keyDown(with: event)
    }
    #expect(submissions == [[], .option, .control, .command])
    #expect(editor.string == "\n")
    let controlO = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .control,
                                               timestamp: 0, windowNumber: 0, context: nil,
                                               characters: "\u{f}", charactersIgnoringModifiers: "o", isARepeat: false, keyCode: 31))
    editor.keyDown(with: controlO)
    #expect(submissions == [[], .option, .control, .command])
    #expect(editor.string == "\n\n")
    editor.setMarkedText("候", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    let commitText = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                                                timestamp: 0, windowNumber: 0, context: nil,
                                                characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
    editor.keyDown(with: commitText)
    #expect(submissions == [[], .option, .control, .command])
}
