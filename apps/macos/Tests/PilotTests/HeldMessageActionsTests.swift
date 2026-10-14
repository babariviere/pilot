import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func heldMessageActionsPreserveUserDraftsAndReleaseBusyState() async {
    let state = ComposerState()
    state.draft = "Unsent user draft"
    let queued = QueuedMessage(json: .object([
        "id": .number(7), "mode": .string("followUp"), "content": .string("Original queued message"),
    ]))!
    state.selectQueuedMessage(queued)
    state.queueEditing.draft = "Queued edit"
    #expect(state.queueEditing.draft == "Queued edit")
    let editing = state.queueEditing
    var calls: [String] = []
    await state.performHeldAction { calls.append("send") }
    var ids: [Int?] = []
    await state.discardHeldMessages(nil) { id in ids.append(id); calls.append("discard-all") }
    await state.discardHeldMessages(42) { id in ids.append(id); calls.append("discard-row-42") }
    #expect(ids.count == 2 && ids[0] == nil && ids[1] == 42)
    #expect(calls == ["send", "discard-all", "discard-row-42"])
    #expect(state.draft == "Unsent user draft")
    #expect(state.queueEditing == editing)
    #expect(state.queueEditing.draft == "Queued edit")
    #expect(!state.mutatingHeldMessages)
}

@Test @MainActor func heldMessageActionFailureAllowsRetryAndPreventsConcurrentActions() async {
    let state = ComposerState()
    state.draft = "Keep"
    await state.performHeldAction { throw ClientError("Could not discard") }
    #expect(state.error == "Could not discard")
    #expect(!state.mutatingHeldMessages)
    await state.performHeldAction {
        #expect(state.mutatingHeldMessages)
        await state.performHeldAction { Issue.record("Duplicate action") }
    }
    #expect(state.error == nil)
    #expect(state.draft == "Keep")
    #expect(!state.mutatingHeldMessages)
}

@Test @MainActor func stoppedComposerShowsOnlyHeldSystemMessages() {
    let held = PendingAutomaticInput(id: 1, origin: .coordinator, mode: .steer, preview: "Correction", queuedAt: 1, held: true)
    let waiting = PendingAutomaticInput(id: 2, origin: .job, mode: .followUp, preview: "Result", queuedAt: 2)
    #expect(SystemMessagesStrip.visible([waiting, held], working: false) == [held])
    #expect(SystemMessagesStrip.visible([waiting, held], working: true).map(\.id) == [1, 2])
}
