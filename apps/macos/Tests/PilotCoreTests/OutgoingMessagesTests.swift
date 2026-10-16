import Foundation
import Testing
@testable import PilotCore

private func queued(_ id: Int, _ text: String) -> QueuedMessage {
    QueuedMessage(json: .object(["id": .number(Double(id)), "mode": .string("steer"), "content": .string(text)]))!
}

private func presentation(_ rows: [ChatRow], queued: [QueuedMessage] = [], working: Bool = false) -> TranscriptPresentation {
    var presentation = TranscriptPresentation()
    presentation.rows = rows
    presentation.queuedMessages = queued
    presentation.working = working
    return presentation
}

@Test func committedUserRowReplacesItsStandIn() {
    let before = presentation([.user(id: "1-0", text: "Earlier"), .text(id: "2-0", text: "Reply")])
    var outgoing = OutgoingMessages()
    let id = outgoing.add("Next question", to: before)
    // History already shown never confirms a send.
    let unchanged = outgoing.reconcile(with: before)
    #expect(!unchanged)
    #expect(outgoing.messages.map(\.id) == [id])
    let committed = presentation(before.rows + [.user(id: "3-0", text: "Next question")], working: true)
    let changed = outgoing.reconcile(with: committed)
    #expect(changed)
    #expect(outgoing.isEmpty)
}

@Test func expandedPromptsConfirmTheOldestMessage() {
    var outgoing = OutgoingMessages()
    outgoing.add("/review", to: presentation([]))
    outgoing.add("Second", to: presentation([]))
    outgoing.reconcile(with: presentation([.user(id: "1-0", text: "Review the change carefully")]))
    #expect(outgoing.messages.map(\.text) == ["Second"])
}

@Test func messagesMatchByTextBeforeOrder() {
    var outgoing = OutgoingMessages()
    outgoing.add("First", to: presentation([]))
    outgoing.add("Second", to: presentation([]))
    outgoing.reconcile(with: presentation([.user(id: "1-0", text: "Second")]))
    #expect(outgoing.messages.map(\.text) == ["First"])
}

@Test func subagentAnswersDoNotConfirmASend() {
    var outgoing = OutgoingMessages()
    outgoing.add("Hello", to: presentation([]))
    outgoing.reconcile(with: presentation([.user(id: "1-0", text: "[subagent \"scout\" answered, no reply needed] Done")]))
    #expect(outgoing.messages.map(\.text) == ["Hello"])
}

@Test func queuedSubmissionInTransitIsHidden() {
    let earlier = queued(4, "Already waiting")
    var outgoing = OutgoingMessages()
    outgoing.add("Hello", to: presentation([], queued: [earlier]))
    outgoing.reconcile(with: presentation([], queued: [earlier, queued(5, "Hello")]))
    #expect(outgoing.hiddenQueueIDs == [5])
    outgoing.reconcile(with: presentation([.user(id: "6-0", text: "Hello")], queued: [earlier], working: true))
    #expect(outgoing.isEmpty)
    #expect(outgoing.hiddenQueueIDs.isEmpty)
}

@Test func unconfirmedAcceptedMessagesExpire() {
    var outgoing = OutgoingMessages()
    let pending = outgoing.add("Waiting on pilotd", to: presentation([]))
    let accepted = outgoing.add("Accepted", to: presentation([]))
    let start = Date(timeIntervalSince1970: 1_000)
    outgoing.accept(accepted, at: start)
    #expect(outgoing.nextDeadline == start.addingTimeInterval(OutgoingMessages.confirmationTimeout))
    outgoing.reconcile(with: presentation([]), now: start.addingTimeInterval(OutgoingMessages.confirmationTimeout))
    #expect(outgoing.messages.map(\.id) == [pending])
    outgoing.remove(pending)
    #expect(outgoing.isEmpty)
}

