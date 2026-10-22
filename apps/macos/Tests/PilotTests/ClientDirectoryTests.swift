import Foundation
import PilotCore
import Testing
@testable import Pilot

private let localHost = HostRef(hostId: "local", daemonId: "mac", lineageId: "mac-history")
private let savedRemoteHost = HostRef(hostId: "box", daemonId: "linux", lineageId: "linux-history")

@Test @MainActor func localDirectoryRejectsRemoteEndpointsWithoutCallingThem() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    var capabilities = 0
    let clients = ClientDirectory(operationDirectory: directory, readNativeCapability: { _ in
        capabilities += 1
        return "must-not-be-read"
    })
    do {
        #expect(clients.localHost == nil)
        let previousLocal = HostRef(hostId: "local", daemonId: "older", lineageId: "older")
        clients.restoreLegacySnapshot(OfflineHostSnapshot(host: previousLocal,
            configuration: try LegacyDevboxAddress(alias: "old-local")))
        let live = PilotClient(); live.loadFixture(projects: [], sessions: [])
        try clients.install(live, host: localHost)
        #expect(clients.localHost == localHost)
        let remote = PilotClient()
        remote.loadFixture(projects: [], sessions: [])
        #expect(throws: HostRoutingError.identityChanged) { try clients.install(remote, host: savedRemoteHost) }
        #expect(throws: HostRoutingError.identityChanged) { try clients.install(remote, host: previousLocal) }
        #expect(clients.localHost == localHost)
        #expect(clients.available == [localHost])
        var invoked = false
        for host in [savedRemoteHost, previousLocal] {
            do {
                let ref = HostResourceRef(host: host, kind: .session, localId: "same")
                _ = try await clients.perform(ref, kind: .session) { _, _ in invoked = true }
                Issue.record("A historical endpoint was admitted")
            } catch { #expect(error as? HostRoutingError == .disconnected) }
        }
        #expect(!invoked && capabilities == 0)
        #expect(try clients.endpoint(localHost) === live)
        await clients.disconnectAll()
        #expect(clients.localHost == nil)
        try? FileManager.default.removeItem(at: directory)
    } catch {
        await clients.disconnectAll()
        try? FileManager.default.removeItem(at: directory)
        throw error
    }
}

@Test(arguments: [false, true]) @MainActor
func disconnectedHistoryNoticeStaysReadOnlyWithoutReconnect(cached: Bool) throws {
    let clients = ClientDirectory()
    let context = HostViewContext(host: savedRemoteHost, hosts: clients)
    let message = DisconnectedHistoryMessage(context: context, historyCached: cached)
    #expect(message.title == "Remote history · box")
    #expect(message.detail.contains(cached ? "Cached history is read-only" : "not cached on this Mac"))
    #expect(!message.detail.contains("Reconnect"))
    let ownership = try #require(message.ownership)
    #expect(ownership.contains("does not stop work"))
}

@Test @MainActor func localHistoryNoticeKeepsLocalOutageSeparateFromRemoteHistory() {
    let context = HostViewContext(host: localHost, hosts: ClientDirectory())
    let message = DisconnectedHistoryMessage(context: context, historyCached: true)
    #expect(message.title == "Local daemon unavailable")
    #expect(message.detail.contains("pilotd") && message.detail.contains("stays on this Mac"))
    #expect(!message.detail.contains("Remote devboxes"))
    #expect(message.ownership == nil)
}
