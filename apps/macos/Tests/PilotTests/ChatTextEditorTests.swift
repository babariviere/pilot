import AppKit
import Testing
@testable import Pilot

private final class EditObserver: NSObject, NSTextViewDelegate {
    var changes = 0
    func textDidChange(_ notification: Notification) { changes += 1 }
}

private func pickerKey(_ code: UInt16, _ characters: String, flags: NSEvent.ModifierFlags = []) throws -> NSEvent {
    try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                                 timestamp: 0, windowNumber: 0, context: nil,
                                 characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
}

@Test @MainActor func pickerKeysTakePrecedenceOverQueueSaveAndCancel() throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    for file in ["README.md", "Report.txt"] { try Data().write(to: directory.appendingPathComponent(file)) }
    let editor = SubmitTextView()
    editor.completionDirectory = directory.path
    editor.string = "R"
    editor.setSelectedRange(NSRange(location: 1, length: 0))
    var saves = 0
    var cancellations = 0
    var queueNavigations = 0
    editor.onSubmit = { _ in saves += 1 }
    editor.onCancel = { cancellations += 1; return true }
    editor.onNavigateQueue = { _ in queueNavigations += 1; return true }
    editor.insertTab(nil)
    editor.keyDown(with: try pickerKey(125, "\u{f701}"))
    #expect(editor.pathPicker?.model.selected == 1)
    editor.keyDown(with: try pickerKey(126, "\u{f700}"))
    #expect(editor.pathPicker?.model.selected == 0)
    editor.keyDown(with: try pickerKey(48, "\t", flags: .shift))
    #expect(editor.pathPicker?.model.selected == 1)
    editor.keyDown(with: try pickerKey(53, "\u{1b}"))
    #expect(editor.pathPicker == nil)
    #expect(editor.string == "R")
    #expect(cancellations == 0)
    #expect(queueNavigations == 0)
    editor.keyDown(with: try pickerKey(53, "\u{1b}"))
    #expect(cancellations == 1)
    for code: UInt16 in [36, 76, 48] {
        editor.string = "R"
        editor.setSelectedRange(NSRange(location: 1, length: 0))
        editor.insertTab(nil)
        editor.keyDown(with: try pickerKey(code, code == 48 ? "\t" : "\r"))
        #expect(editor.string == "README.md")
        #expect(editor.pathPicker == nil)
        #expect(saves == 0)
    }
    editor.keyDown(with: try pickerKey(36, "\r"))
    #expect(saves == 1)
}

@Test @MainActor func optionArrowsStillNavigateQueueAndDismissThePicker() throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    for file in ["README.md", "Report.txt"] { try Data().write(to: directory.appendingPathComponent(file)) }
    let editor = SubmitTextView()
    editor.completionDirectory = directory.path
    editor.string = "R"
    editor.setSelectedRange(NSRange(location: 1, length: 0))
    var directions: [String] = []
    editor.onNavigateQueue = { directions.append($0 == .up ? "up" : "down"); return true }
    for code: UInt16 in [126, 125] {
        editor.keyDown(with: try pickerKey(code, "", flags: .option))
        editor.insertTab(nil)
        #expect(editor.pathPicker != nil)
        editor.keyDown(with: try pickerKey(code, "", flags: .option))
        #expect(editor.pathPicker == nil)
        #expect(editor.string == "R")
    }
    #expect(directions == ["up", "up", "down", "down"])
    editor.keyDown(with: try pickerKey(126, "", flags: [.option, .shift]))
    #expect(directions.count == 4)
    editor.setMarkedText("候", selectedRange: NSRange(location: 1, length: 0),
                         replacementRange: NSRange(location: NSNotFound, length: 0))
    editor.keyDown(with: try pickerKey(126, "", flags: .option))
    #expect(directions.count == 4)
}

@Test @MainActor func returnHandledByCompletionDoesNotAlsoSubmit() throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    for file in ["README.md", "Report.txt"] { try Data().write(to: directory.appendingPathComponent(file)) }
    let editor = SubmitTextView()
    editor.completionDirectory = directory.path
    editor.string = "Read R"
    editor.setSelectedRange(NSRange(location: 6, length: 0))
    var submissions = 0
    editor.onSubmit = { _ in submissions += 1 }
    editor.insertTab(nil)
    #expect(editor.pathPicker?.model.candidates == ["README.md", "Report.txt"])
    let event = try pickerKey(36, "\r")
    editor.keyDown(with: event)
    #expect(editor.string == "Read README.md")
    #expect(submissions == 0)
    #expect(editor.pathPicker == nil)
    editor.keyDown(with: event)
    #expect(submissions == 1)
}

@Test @MainActor func pathPickerNavigationCancellationAndMouseSelection() throws {
    _ = NSApplication.shared
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    for file in ["README.md", "Report.txt"] { try Data().write(to: directory.appendingPathComponent(file)) }
    let editor = SubmitTextView()
    editor.completionDirectory = directory.path
    editor.string = "R"
    editor.setSelectedRange(NSRange(location: 1, length: 0))
    editor.insertTab(nil)
    editor.keyDown(with: try pickerKey(125, "\u{f701}"))
    #expect(editor.pathPicker?.model.selected == 1)
    editor.keyDown(with: try pickerKey(126, "\u{f700}"))
    #expect(editor.pathPicker?.model.selected == 0)
    editor.keyDown(with: try pickerKey(48, "\t", flags: .shift))
    #expect(editor.pathPicker?.model.selected == 1)
    editor.keyDown(with: try pickerKey(53, "\u{1b}"))
    #expect(editor.pathPicker == nil)
    #expect(editor.string == "R")
    editor.insertTab(nil)
    editor.pathPicker?.model.choose?(1)
    #expect(editor.string == "Report.txt")
    editor.string = "R"
    editor.setSelectedRange(NSRange(location: 1, length: 0))
    editor.insertTab(nil)
    editor.keyDown(with: try pickerKey(48, "\t"))
    #expect(editor.string == "README.md")
    editor.string = "R"
    editor.setSelectedRange(NSRange(location: 1, length: 0))
    editor.insertTab(nil)
    editor.completionDirectory = "/"
    #expect(editor.pathPicker == nil)
    editor.completionDirectory = directory.path
    editor.insertTab(nil)
    editor.string = "changed outside the editor"
    editor.pathPicker?.model.choose?(0)
    #expect(editor.string == "changed outside the editor")
    #expect(editor.pathPicker == nil)
}

@Test @MainActor func pathPickerStaysWithinSmallAndSecondaryScreens() {
    let compact = PathCompletionPicker.frame(caret: CGRect(x: 300, y: 600, width: 0, height: 18),
                                             screen: CGRect(x: 0, y: 0, width: 1440, height: 900), count: 3)
    #expect(compact.height == 184) // Three compact rows plus keyboard footer and insets, no header.
    for screen in [CGRect(x: 0, y: 0, width: 380, height: 300), CGRect(x: -1440, y: 0, width: 1440, height: 900)] {
        for caret in [CGRect(x: screen.minX, y: screen.minY, width: 0, height: 18),
                      CGRect(x: screen.maxX, y: screen.maxY, width: 0, height: 18)] {
            let frame = PathCompletionPicker.frame(caret: caret, screen: screen, count: 100)
            #expect(screen.insetBy(dx: 12, dy: 12).contains(frame))
        }
    }
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
