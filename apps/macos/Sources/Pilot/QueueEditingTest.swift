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
            for _ in 0..<8 {
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
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                                        timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                        characters: code == 36 ? "\r" : code == 51 ? "\u{7f}" : "", charactersIgnoringModifiers: "",
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
        check(model.saves.count == 1 && model.saves[0].0 == 10 && model.saves[0].1 == "Edited first", "Enter saves selected message once")
        check(model.removals.isEmpty, "Command-Delete cannot remove during save")
        check(state.queueEditing.selected == nil && editor() === composerEditor, "successful save restores composer focus")
        press(125, .option)
        await settle()
        check(state.queueEditing.selected?.id == 11, "Alt-Down starts at first steering row")
        type("A line")
        press(36, .shift)
        check(state.queueEditing.draft.contains("\n") && model.saves.count == 1, "Shift-Enter inserts newline")
        press(36, .option)
        await settle()
        check(model.saves.count == 2 && model.saves[1].0 == 11 && model.sends.isEmpty, "Option-Enter also saves, never sends")
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
        press(51, .command)
        await settle()
        check(model.removals.isEmpty && editor().string == "Retain failed draft", "consumed message cannot be removed or its draft deleted")
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
        model.rejectRemove = true
        press(51, .command)
        await settle()
        check(state.queueRemovalError != nil && state.queueEditing.draft == "Keep failed removal draft", "failed shortcut removal keeps edit")
        model.rejectRemove = false
        press(51, .command)
        press(51, .command)
        press(125, .option)
        await settle()
        check(model.removals == [removalId] && !model.messages.contains(where: { $0.id == removalId }), "Command-Delete removes selected follow-up only once")
        check(state.queueEditing.selected == nil && editor() === composerEditor, "shortcut removal restores composer focus")
        check(state.draft == "Keep my composer draft" && model.saves.count == 2, "shortcut removal does not save or modify composer draft")
        press(125, .option)
        await settle()
        let steeringId = state.queueEditing.selected!.id
        press(51, .command)
        await settle()
        check(model.removals == [removalId, steeringId] && editor() === composerEditor, "Alt-Down and Command-Delete remove steering too")
        press(36)
        press(36, .option)
        check(model.sends == [.steer, .followUp] && state.draft == "Keep my composer draft", "main composer and send shortcuts are unchanged")
        print("queue-edit-test passed: inline focus, arrows, drafts, Enter, Escape, Shift-Enter, Command-Delete, failed/stale saves and removals")
        window.orderOut(nil)
        exit(0)
    }

    @MainActor
    private final class Model: ObservableObject {
        let composer = ComposerState()
        @Published var messages: [QueuedMessage]
        var saves: [(Int, String)] = []
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
                     onEditQueuedMessage: { id, text in
                         try await Task.sleep(for: .milliseconds(100))
                         if model.rejectSave { throw NSError(domain: "Save rejected", code: 1) }
                         model.saves.append((id, text))
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
