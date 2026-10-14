import Foundation
import Testing
@testable import PilotCore

@Test func updatePauseIdentifiesItsDaemonWhileLegacyIdlePreparationStillDecodes() throws {
    let paused = try JSONDecoder().decode(UpdatePreparation.self, from: Data(#"{"ready":true,"processId":1234}"#.utf8))
    #expect(paused.ready)
    #expect(paused.processId == 1234)
    let legacy = try JSONDecoder().decode(UpdatePreparation.self, from: Data(#"{"ready":true}"#.utf8))
    #expect(legacy.ready)
    #expect(legacy.processId == nil)
}
