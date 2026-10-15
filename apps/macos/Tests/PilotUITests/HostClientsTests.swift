import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func hostClientsKeepCollidingIDsAndDisconnectedOutcomesIsolated() async throws {
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    let remote = HostRef(hostId: "box", daemonId: "b", lineageId: "2")
    let localClient = PilotClient()
    let remoteClient = PilotClient()
    let project = Project(id: "project", name: "Repo", path: "/same/path", createdAt: 0)
    let localSession = SessionSummary(id: "session", title: "Local", cwd: "/same/path",
                                     createdAt: 0, updatedAt: 0, state: "idle")
    let remoteSession = SessionSummary(id: "session", title: "Remote", cwd: "/same/path",
                                      createdAt: 0, updatedAt: 0, state: "working")
    localClient.loadFixture(projects: [project], sessions: [localSession])
    remoteClient.loadFixture(projects: [project], sessions: [remoteSession])
    let hosts = HostClients()
    hosts.install(localClient, host: local)
    hosts.install(remoteClient, host: remote)
    #expect(hosts.sessions.count == 2)
    #expect(Set(hosts.sessions.map(\.ref)).count == 2)
    #expect(hosts.projects.count == 2)
    await hosts.disconnect(remote)
    #expect(hosts.sessions.first { $0.ref.host == remote }?.value.state == "working")
    #expect(hosts.available.contains(local))
    #expect(!hosts.available.contains(remote))
    let ref = HostResourceRef(host: remote, kind: .session, localId: "session")
    var invoked = false
    do {
        _ = try await hosts.perform(ref, kind: .session) { _, _ in invoked = true; return true }
        Issue.record("Disconnected route unexpectedly succeeded")
    } catch { #expect(error as? HostRoutingError == .disconnected) }
    #expect(!invoked)
    #expect(localClient.connected)
}

