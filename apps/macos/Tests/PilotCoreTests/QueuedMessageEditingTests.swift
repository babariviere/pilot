import Foundation
import Testing
@testable import PilotCore

private func queued(_ id: Int, _ mode: DeliveryMode, _ text: String) -> QueuedMessage {
    QueuedMessage(json: .object([
        "id": .number(Double(id)), "mode": .string(mode.rawValue), "content": .string(text),
    ]))!
}

@Test func queueNavigationStartsAtTheNearestEdgeAndClampsAtTheEnds() {
    let messages = [queued(3, .steer, "Steering"), queued(1, .followUp, "First"), queued(2, .followUp, "Last")]
    var editing = QueuedMessageEditing()
    let handled = editing.navigate(.up, messages: messages)
    #expect(handled)
    #expect(editing.selected?.id == 2)
    #expect(editing.draft == "Last")
    _ = editing.navigate(.up, messages: messages)
    #expect(editing.selected?.id == 1)
    _ = editing.navigate(.up, messages: messages)
    #expect(editing.selected?.id == 3)
    _ = editing.navigate(.up, messages: messages)
    #expect(editing.selected?.id == 3)
    for _ in 0..<4 { _ = editing.navigate(.down, messages: messages) }
    #expect(editing.selected?.id == 2)
    editing.finish()
    _ = editing.navigate(.down, messages: messages)
    #expect(editing.selected?.id == 3)
}

@Test func switchingQueueEditsPreservesDraftsUntilAcceptOrCancel() {
    let messages = [queued(1, .steer, "Original steering"), queued(2, .followUp, "Original follow-up")]
    var editing = QueuedMessageEditing()
    editing.select(messages[0])
    editing.draft = "Changed steering\nDetails"
    #expect(editing.hasUnsavedEdit(messages[0]))
    _ = editing.navigate(.down, messages: messages)
    editing.draft = "Changed follow-up"
    _ = editing.navigate(.up, messages: messages)
    #expect(editing.draft == "Changed steering\nDetails")
    editing.finish()
    #expect(editing.selected == nil)
    #expect(!editing.hasUnsavedEdit(messages[0]))
    editing.select(messages[0])
    #expect(editing.draft == "Original steering")
    _ = editing.navigate(.down, messages: messages)
    #expect(editing.draft == "Changed follow-up")
    #expect(messages.map(\.text) == ["Original steering", "Original follow-up"])
}

@Test func consumedQueueMessagesRetainTheActiveDraftAndNavigationHandlesEmptyQueues() {
    let message = queued(1, .followUp, "Original")
    var editing = QueuedMessageEditing()
    let empty = editing.navigate(.up, messages: [])
    #expect(!empty)
    #expect(editing.selected == nil)
    editing.select(message)
    editing.draft = "Keep my draft"
    let consumed = editing.navigate(.down, messages: [])
    #expect(!consumed)
    #expect(editing.selected?.id == 1 && editing.draft == "Keep my draft")
    _ = editing.navigate(.down, messages: [queued(2, .steer, "Next")])
    #expect(editing.selected?.id == 2)
    editing.finish()
    #expect(editing.draft.isEmpty)
}
