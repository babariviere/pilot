import PilotCore
import Testing
@testable import Pilot

@Test func coordinatorActivityUsesTheSharedCompassSymbol() {
    #expect(MissionCoordinatorIndicator.symbol == "safari")
    #expect(MissionEventKind.coordinator.symbol == MissionCoordinatorIndicator.symbol)
}
