import AppKit
import PilotCore
import SwiftUI

/// Exercises real NSTextView key events and focus without a daemon or screen-recording permission.
@MainActor
enum QueueEditingTest {
    static func run() async {
        let model = Model()
        let state = model.composer
        state.draft = "Keep my composer draft"
        let root = TestView(model: model).frame(width: 760, height: 540)
        let hosting = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 540),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = hosting
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless()
        func settle() async {
            // Outlast Theme.Motion.standard so animated row removals finish between key presses.
            for _ in 0..<16 {
                hosting.layoutSubtreeIfNeeded()
                try? await Task.sleep(for: .milliseconds(25))
            }
        }
        func check(_ condition: Bool, _ step: String) {
            if !condition { print("queue-edit-test failed: \(step)"); exit(1) }
        }
        func editor() -> SubmitTextView {
            guard let editor = window.firstResponder as? SubmitTextView else {
                print("queue-edit-test failed: text editor focus"); exit(1)
            }
            return editor
        }
        func press(_ code: UInt16, _ flags: NSEvent.ModifierFlags = []) {
            let characters = code == 36 ? "\r" : code == 51 ? "\u{7f}" : ""
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                                        timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                        characters: characters, charactersIgnoringModifiers: characters,
                                        isARepeat: false, keyCode: code)!
            window.sendEvent(event)
        }
        func type(_ text: String) {
            editor().selectAll(nil)
            editor().insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
        }
        await settle()
        let composerEditor = editor()
        press(126, .option)
        await settle()
        check(state.queueEditing.selected?.id == 12 && editor() !== composerEditor, "Alt-Up selects last row inline")
        check(editor().visibleRect.height > 15 && editor().visibleRect.width > 100, "inline editor is visible")
        check(window.attachedSheet == nil, "no popup")
        type("Edited last")
        press(126, .option)
        await settle()
        check(state.queueEditing.selected?.id == 10, "Alt-Up follows displayed order")
        type("Edited first")
        press(125, .option)
        await settle()
        check(state.queueEditing.draft == "Edited last" && editor().string == "Edited last", "navigation retains drafts")
        window.makeFirstResponder(composerEditor)
        press(125, .option)
        await settle()
        check(editor() !== composerEditor, "navigation at boundary focuses inline editor")
        press(53)
        await settle()
        check(state.queueEditing.selected == nil && editor() === composerEditor, "Escape cancels and restores focus")
        press(126, .option)
        await settle()
        check(state.queueEditing.draft == "Last follow-up", "canceled edit was discarded")
        press(126, .option)
        await settle()
        check(editor().string == "Edited first", "other draft survives cancel")
        press(36)
        check(state.savingQueueEdit, "Enter begins save")
        press(36)
        press(51, .command)
        press(126, .option)
        press(53)
        check(state.queueEditing.selected?.id == 10, "selection is frozen during save")
        await settle()
        check(model.saves.count == 1 && model.saves[0].0 == 10 && model.saves[0].1 == "Edited first"
              && model.saves[0].2 == .steer, "Enter saves selected follow-up once, as steering")
        check(model.removals.isEmpty, "busy edit cannot remove")
        check(state.queueEditing.selected == nil && editor() === composerEditor, "successful save restores composer focus")
        press(125, .option)
        await settle()
        check(state.queueEditing.selected?.id == 11, "Alt-Down starts at first steering row")
        type("A line")
        press(36, .shift)
        check(state.queueEditing.draft.contains("\n") && model.saves.count == 1, "Shift-Enter inserts newline")
        press(36, .option)
        await settle()
        check(model.saves.count == 2 && model.saves[1].0 == 11 && model.saves[1].2 == .followUp && model.sends.isEmpty,
              "Option-Enter saves steering as a follow-up, never sends")
        press(126, .option)
        await settle()
        type("Retain failed draft")
        model.rejectSave = true
        press(36)
        await settle()
        check(state.queueEditError != nil && state.queueEditing.draft == "Retain failed draft", "failed save keeps draft inline")
        model.rejectSave = false
        model.messages.removeAll { $0.id == state.queueEditing.selected?.id }
        await settle()
        check(editor().string == "Retain failed draft", "consumption retains active editor")
        press(36)
        check(model.saves.count == 2 && state.queueEditError?.contains("no longer queued") == true, "consumed message cannot be saved")
        type("")
        press(36)
        await settle()
        check(model.removals.isEmpty && state.queueEditError?.contains("no longer queued") == true,
              "empty edit cannot remove consumed message")
        press(53)
        await settle()
        press(126, .option)
        await settle()
        let removalId = state.queueEditing.selected!.id
        type("Keep failed removal draft")
        let queueEditor = editor()
        window.makeFirstResponder(composerEditor)
        press(51, .command)
        await settle()
        check(model.removals.isEmpty && state.queueEditing.selected?.id == removalId, "Command-Delete in composer does not remove selected queue row")
        type("Keep my composer draft")
        window.makeFirstResponder(queueEditor)
        queueEditor.setSelectedRange(NSRange(location: queueEditor.string.utf16.count, length: 0))
        press(51, .command)
        await settle()
        check(model.removals.isEmpty && state.queueEditing.draft.isEmpty,
              "Command-Delete only clears the inline text, without removing the row (draft: \(state.queueEditing.draft.debugDescription))")
        press(36, .shift)
        await settle()
        check(state.queueEditing.draft == "\n" && model.removals.isEmpty, "Shift-Enter in empty edit only inserts newline")
        type("")
        model.rejectRemove = true
        press(36)
        await settle()
        check(state.queueRemovalError != nil && state.queueEditing.draft.isEmpty && editor() === queueEditor,
              "failed empty-edit removal keeps edit and focus for retry")
        try? await Task.sleep(for: .seconds(5))
        await settle()
        check(state.queueRemovalError == nil && state.queueEditing.draft.isEmpty
              && editor() === queueEditor, "removal warning expires without losing draft or focus")
        // Exercise the real warning button with no queued rows, the formerly sticky state.
        // Use known fixture bounds: offscreen SwiftUI does not expose its virtual AX buttons.
        let dismissState = ComposerState()
        dismissState.queueRemovalError = "Removal rejected"
        let dismissHost = NSHostingView(rootView: QueuedMessagesStrip(
            state: dismissState, messages: [], completionDirectory: nil, onSave: { _ in }, onRemove: { _ in }
        ).frame(width: 400, height: 80, alignment: .top))
        let dismissWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 80),
                                     styleMask: [.titled], backing: .buffered, defer: false)
        dismissWindow.contentView = dismissHost
        dismissWindow.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        dismissWindow.orderFrontRegardless()
        dismissHost.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(100))
        let point = NSPoint(x: 378, y: dismissHost.isFlipped ? 17 : 63)
        let location = dismissHost.convert(point, to: nil)
        for eventType in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: eventType, location: location, modifierFlags: [], timestamp: 0,
                                          windowNumber: dismissWindow.windowNumber, context: nil, eventNumber: 1,
                                          clickCount: 1, pressure: eventType == .leftMouseDown ? 1 : 0)!
            dismissWindow.sendEvent(event)
        }
        await settle()
        check(dismissState.queueRemovalError == nil, "clicking dismiss clears removal warning with an empty queue")
        dismissWindow.orderOut(nil)
        window.makeFirstResponder(queueEditor)
        model.rejectRemove = false
        press(36)
        try? await Task.sleep(for: .milliseconds(10))
        check(state.removingQueuedMessage == removalId, "empty Enter begins removal")
        press(36)
        press(125, .option)
        press(53)
        check(state.queueEditing.selected?.id == removalId, "selection is frozen during removal")
        await settle()
        check(model.removals == [removalId] && !model.messages.contains(where: { $0.id == removalId }), "empty Enter removes selected follow-up only once")
        check(state.queueEditing.selected == nil && editor() === composerEditor, "empty Enter removal restores composer focus")
        check(state.draft == "Keep my composer draft" && model.saves.count == 2, "removal does not save or modify composer draft")
        press(125, .option)
        await settle()
        let steeringId = state.queueEditing.selected!.id
        type(" \n\t ")
        press(36, .option)
        await settle()
        check(model.removals == [removalId, steeringId] && editor() === composerEditor, "whitespace-only Option-Enter removes steering too")
        press(36)
        press(36, .option)
        check(model.sends == [.steer, .followUp] && state.draft == "Keep my composer draft", "main composer and send shortcuts are unchanged")
        print("queue-edit-test passed: inline focus, arrows, drafts, Enter/Option-Enter modes and empty removal, Escape, Shift-Enter, native Command-Delete, failed/stale saves and removals")
        window.orderOut(nil)
        exit(0)
    }

    @MainActor
    private final class Model: ObservableObject {
        let composer = ComposerState()
        @Published var messages: [QueuedMessage]
        var saves: [(Int, String, DeliveryMode)] = []
        var sends: [DeliveryMode] = []
        var rejectSave = false
        var removals: [Int] = []
        var rejectRemove = false

        init() {
            var transcript = Transcript()
            transcript.apply(try! JSONValue.decode(Data(#"{"type":"queue_update","items":[{"id":10,"mode":"followUp","content":"First follow-up"},{"id":11,"mode":"steer","content":"First steering"},{"id":12,"mode":"followUp","content":"Last follow-up"},{"id":13,"mode":"steer","content":"Last steering"}]}"#.utf8)))
            messages = transcript.queuedMessagesInDeliveryOrder
        }
    }

    private struct TestView: View {
        @ObservedObject var model: Model

        var body: some View {
            Composer(state: model.composer, working: true, queuedMessages: model.messages,
                     completionDirectory: FileManager.default.temporaryDirectory.path,
                     onSend: { _, mode in model.sends.append(mode) }, onStop: {},
                     onEditQueuedMessage: { id, text, mode in
                         try await Task.sleep(for: .milliseconds(100))
                         if model.rejectSave { throw NSError(domain: "Save rejected", code: 1) }
                         model.saves.append((id, text, mode))
                     },
                     onRemoveQueuedMessage: { id in
                         try await Task.sleep(for: .milliseconds(100))
                         if model.rejectRemove { throw ClientError("Removal rejected") }
                         model.removals.append(id)
                         model.messages.removeAll { $0.id == id }
                     })
        }
    }
}
