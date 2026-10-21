import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func qualifiedSubscriptionsReattachOnlyToTheirPinnedReplacementEndpoint() async throws {
    let host = HostRef(hostId: "local", daemonId: "daemon", lineageId: "history")
    let ref = HostResourceRef(host: host, kind: .session, localId: "same")
    func fixture() -> PilotClient {
        let client = PilotClient()
        client.loadFixture(projects: [], sessions: [
            SessionSummary(id: "same", title: "Chat", cwd: "/same", createdAt: 0, updatedAt: 0, state: "working"),
        ])
        return client
    }
    let hosts = ClientDirectory()
    let old = fixture()
    try hosts.install(old, host: host)
    let fence = try hosts.token(for: host)
    var received = 0
    let unsubscribe = try hosts.subscribe(ref) { _ in received += 1 }
    old.handle(.events(sessionId: "same", events: [.string("old")], seq: nil))
    #expect(received == 1)
    await hosts.disconnect(host)
    old.handle(.events(sessionId: "same", events: [.string("late")], seq: nil))
    #expect(received == 1)
    let replacement = fixture()
    try hosts.install(replacement, host: host)
    old.handle(.events(sessionId: "same", events: [.string("older")], seq: nil))
    replacement.handle(.events(sessionId: "same", events: [.string("new")], seq: nil))
    #expect(received == 2)
    #expect(throws: HostRoutingError.staleGeneration) { try hosts.validate(fence) }
    unsubscribe()
    unsubscribe()
    replacement.handle(.events(sessionId: "same", events: [.string("after unsubscribe")], seq: nil))
    #expect(received == 2)
    #expect(throws: HostRoutingError.identityChanged) {
        try hosts.install(replacement, host: HostRef(hostId: "other", daemonId: "daemon", lineageId: "history"))
    }
}
