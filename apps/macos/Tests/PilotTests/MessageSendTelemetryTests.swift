import PilotCore
import PilotTelemetry
import Testing
@testable import Pilot

@MainActor @Test func messageSendProgressDistinguishesThinkingTextAndMissingMilestones() {
    let baseline: Set<String> = ["old"]
    let rows: [ChatRow] = [
        .text(id: "old", text: "Earlier"),
        .work(id: "work", group: TurnWork(rows: [
            .thinking(id: "thinking", text: "Planning", streaming: true),
            .tools(id: "tools", items: []),
        ], startedAt: nil, endedAt: nil)),
        .text(id: "answer", text: "Visible"),
    ]
    let first = MessageSendTelemetry.firstProgress(in: rows, excluding: baseline)
    #expect(first?.0 == .thinking)
    #expect(first?.1 == .completed)
    #expect(MessageSendTelemetry.firstProgress(in: [.text(id: "old", text: "Earlier")], excluding: baseline) == nil)
}

@MainActor @Test func messageSendProgressTreatsVisibleFailureAsFailedWithoutItsText() {
    let first = MessageSendTelemetry.firstProgress(
        in: [.error(id: "failure", text: "private provider detail")],
        excluding: []
    )
    #expect(first?.0 == PilotProgressKind.none)
    #expect(first?.1 == .failed)
}
