import PilotCore
import Testing
@testable import Pilot

@Test func coordinatorActivityUsesTheSharedCompassSymbol() {
    #expect(PilotIcon.coordinator.systemName == "safari")
    #expect(MissionEventKind.coordinator.icon == PilotIcon.coordinator)
}
