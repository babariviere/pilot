import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private let waiting = [
    PendingAutomaticInput(id: 1, origin: .job, mode: .followUp, preview: "Tests passed", queuedAt: 1_000),
    PendingAutomaticInput(id: 2, origin: .coordinator, mode: .steer, preview: "Use the shared divider", queuedAt: 2_000),
    PendingAutomaticInput(id: 3, origin: .job, mode: .followUp, preview: "Lint passed", queuedAt: 3_000),
]

@MainActor
private func fittingHeight(_ view: some View) -> CGFloat {
    _ = NSApplication.shared
    let hosting = NSHostingView(rootView: view.frame(width: 600))
    hosting.layoutSubtreeIfNeeded()
    return hosting.fittingSize.height
}

@Test @MainActor func systemMessagesShowACountWithOriginsAndModes() {
    let strip = SystemMessagesStrip(inputs: SystemMessagesStrip.visible(waiting, working: true))
    #expect(strip.inputs.map(\.id) == [2, 1, 3], "steering is listed first, like the queue")
    #expect(strip.title == "3 system messages")
    #expect(strip.origins == [.coordinator, .job])
    #expect(strip.modes == [.steer, .followUp])
    #expect(!strip.held)
    #expect(SystemMessagesStrip(inputs: [waiting[0]]).title == "1 system message")
}

@Test func coordinatorAndMissionMessagesUseTheSharedMarks() {
    #expect(InputOrigin.coordinator.icon == PilotIcon.coordinator)
    #expect(InputOrigin.coordinator.title == "Coordinator")
    #expect(InputOrigin.mission.icon == PilotIcon.mission)
}

@Test @MainActor func systemMessagesHideWhenNoneWaitOrTheChatIsIdle() {
    #expect(SystemMessagesStrip.visible([], working: true).isEmpty)
    #expect(SystemMessagesStrip.visible(waiting, working: false).isEmpty, "an idle chat starts a run right away")
    let held = PendingAutomaticInput(id: 4, origin: .pullRequest, mode: .followUp, preview: "CI failed",
                                     queuedAt: 4_000, held: true)
    let visible = SystemMessagesStrip.visible(waiting + [held], working: false)
    #expect(visible.map(\.id) == [4], "held messages stay visible after Stop")
    let strip = SystemMessagesStrip(inputs: visible)
    #expect(strip.held)
    #expect(strip.title == "1 system message held")

    let state = ComposerState()
    func composer(_ inputs: [PendingAutomaticInput], working: Bool) -> some View {
        Composer(state: state, working: working, queuedMessages: [], automaticInputs: inputs, completionDirectory: nil,
                 onSend: { _, _ in }, onStop: {}, onEditQueuedMessage: { _, _, _ in }, onRemoveQueuedMessage: { _ in })
    }
    let empty = fittingHeight(composer([], working: true))
    #expect(fittingHeight(composer(waiting, working: false)) == empty)
    #expect(fittingHeight(composer(waiting, working: true)) > empty)
}

@Test @MainActor func systemMessagesExpandIntoOneReadOnlyRowEach() {
    let collapsed = fittingHeight(SystemMessagesStrip(inputs: waiting))
    let expanded = fittingHeight(SystemMessagesStrip(inputs: waiting, expanded: true))
    let row = QueuedMessagesStrip.rowHeight
    #expect(collapsed >= row && collapsed < row * 2)
    #expect(expanded >= collapsed + CGFloat(waiting.count) * row)
    #expect(expanded < collapsed + CGFloat(waiting.count + 1) * row)
}
