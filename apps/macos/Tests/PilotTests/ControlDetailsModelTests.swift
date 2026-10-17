import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func controlInvalidationsReachOnlyInstalledObservers() {
    let client = PilotClient()
    var changes: [ControlDetailsChange] = []
    let id = client.observeControlDetails { changes.append($0) }
    client.handle(.watchesChanged)
    client.handle(.controlAuditChanged)
    #expect(changes == [.watches, .audit])
    client.stopObservingControlDetails(id)
    client.handle(.watchesChanged)
    #expect(changes == [.watches, .audit])
}

@Test @MainActor func watchingTabIsOnlyForTheControlChat() {
    var control = SessionSummary(id: "c", title: "Control", cwd: "", createdAt: 1, updatedAt: 1, state: "idle",
                                 mode: .ask, pinned: true)
    control.control = true
    let ask = SessionSummary(id: "a", title: "Ask", cwd: "/tmp", createdAt: 1, updatedAt: 1, state: "idle", mode: .ask)
    #expect(InspectorTab.watching.isAvailable(for: control))
    #expect(!InspectorTab.watching.isAvailable(for: ask))
    #expect(InspectorTab.artifacts.isAvailable(for: control))
}

