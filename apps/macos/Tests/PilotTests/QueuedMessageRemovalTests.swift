import Foundation
import PilotCore
import Testing
@testable import Pilot

private func removalMessage(_ id: Int) -> QueuedMessage {
    QueuedMessage(json: .object([
        "id": .number(Double(id)), "mode": .string("followUp"), "content": .string("Message \(id)"),
    ]))!
}

@Test @MainActor func removingTheEditedMessageClearsOnlyItsDraftAndRestoresComposerFocus() async {
    let state = ComposerState()
    state.draft = "Keep composer draft"
    state.selectQueuedMessage(removalMessage(2))
    state.queueEditing.draft = "Other edit"
    state.selectQueuedMessage(removalMessage(1))
    state.queueEditing.draft = "Selected edit"
    let focus = state.composerFocus
    var removed: [Int] = []
    await state.removeQueuedMessage(1) { id in removed.append(id) }
    #expect(removed == [1])
    #expect(!state.mutatingQueue)
    #expect(state.queueEditing.selected == nil)
    #expect(state.composerFocus != focus)
    #expect(state.draft == "Keep composer draft")
    #expect(state.remainingQueuedMessages([removalMessage(1), removalMessage(2)]).map(\.id) == [2])
    state.selectQueuedMessage(removalMessage(2))
    #expect(state.queueEditing.draft == "Other edit")
    state.selectQueuedMessage(removalMessage(1))
    #expect(state.queueEditing.selected?.id == 2)
    #expect(!state.queueEditing.hasUnsavedEdit(removalMessage(1)))
    _ = state.navigateQueue(.up, messages: [removalMessage(1), removalMessage(2)])
    #expect(state.queueEditing.selected?.id == 2)
}

@Test @MainActor func failedRemovalKeepsDraftAndAllowsRetry() async {
    let state = ComposerState()
    state.selectQueuedMessage(removalMessage(1))
    state.queueEditing.draft = "Keep this edit"
    let focus = state.composerFocus
    await state.removeQueuedMessage(1) { _ in throw ClientError("Message is no longer queued.") }
    #expect(state.queueRemovalError == "Message is no longer queued.")
    #expect(state.remainingQueuedMessages([removalMessage(1)]).map(\.id) == [1])
    #expect(state.queueEditing.selected?.id == 1)
    #expect(state.queueEditing.draft == "Keep this edit")
    #expect(state.composerFocus == focus)
    #expect(!state.mutatingQueue)
    await state.removeQueuedMessage(1) { _ in }
    #expect(state.queueRemovalError == nil)
    #expect(state.queueEditing.selected == nil)
    #expect(state.remainingQueuedMessages([removalMessage(1)]).isEmpty)
}

@Test @MainActor func removingAnotherRowPreservesActiveEditorAndSerializesQueueMutations() async {
    let state = ComposerState()
    state.selectQueuedMessage(removalMessage(1))
    state.queueEditing.draft = "Keep this edit"
    let focus = state.composerFocus
    await state.removeQueuedMessage(2) { id in
        #expect(id == 2 && state.removingQueuedMessage == 2)
        state.selectQueuedMessage(removalMessage(3))
        state.cancelQueueEdit()
        _ = state.navigateQueue(.down, messages: [removalMessage(1), removalMessage(3)])
        await state.removeQueuedMessage(3) { _ in Issue.record("Duplicate removal") }
        #expect(state.queueEditing.selected?.id == 1)
        #expect(state.mutatingQueue)
    }
    #expect(state.queueEditing.selected?.id == 1)
    #expect(state.queueEditing.draft == "Keep this edit")
    #expect(state.composerFocus == focus)
    #expect(!state.mutatingQueue)
    state.savingQueueEdit = true
    await state.removeQueuedMessage(1) { _ in Issue.record("Removal during save") }
    #expect(state.queueEditing.selected?.id == 1)
}
