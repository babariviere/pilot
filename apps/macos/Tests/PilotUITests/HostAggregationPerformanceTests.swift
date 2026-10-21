import Combine
import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func unifiedAggregationCoalescesStreamingBurstsWithTenThousandSessions() async throws {
    let rows = (0..<10_000).map { id in
        SessionSummary(id: String(id), title: "Chat \(id)", cwd: "/repo", createdAt: 0, updatedAt: 0, state: "idle")
    }
    func update(_ client: PilotClient) {
        for id in 0..<20 {
            client.handle(.session(SessionSummary(id: String(id), title: "Updated \(id)", cwd: "/repo",
                                                  createdAt: 0, updatedAt: 1, state: "working")))
        }
    }
    let baseline = PilotClient()
    baseline.loadFixture(projects: [], sessions: rows)
    let baselineTime = ContinuousClock().measure { update(baseline) }
    let client = PilotClient()
    client.loadFixture(projects: [], sessions: rows)
    let hosts = HostClients()
    try hosts.install(client, host: HostRef(hostId: "local", daemonId: "daemon", lineageId: "history"))
    for _ in 0..<1000 {
        if !hosts.hasPendingUpdates { break }
        await Task.yield()
    }
    try #require(!hosts.hasPendingUpdates)
    var publications = 0
    let observation = hosts.$sessions.dropFirst().sink { _ in publications += 1 }
    let start = ContinuousClock.now
    update(client)
    for _ in 0..<1000 {
        if !hosts.hasPendingUpdates { break }
        await Task.yield()
    }
    try #require(!hosts.hasPendingUpdates)
    let elapsed = start.duration(to: .now)
    #expect(hosts.sessions.count == 10_000)
    #expect(hosts.sessions.filter { $0.value.state == "working" }.count == 20)
    #expect(publications == 1, "One latest-value aggregation, not twenty full sidebar rebuilds")
    print("10k chats, 20 updates: endpoint-only \(baselineTime), unified + coalesced \(elapsed)")
    withExtendedLifetime(observation) {}
}

@Test @MainActor func persistentRemoteAggregationCoalescesTenThousandSessionStreamingAndFlushesLatestOnly() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let host = HostRef(hostId: "box", daemonId: "remote", lineageId: "history")
    let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
    let store = OfflineHostStore(directory: directory.appendingPathComponent("hosts"))
    try await store.save([OfflineHostSnapshot(host: host, configuration: SSHConnectionConfiguration(alias: "fixture"))])
    try await hosts.restoreOffline(from: store)
    let rows = (0..<10_000).map {
        SessionSummary(id: String($0), title: "Chat \($0)", cwd: "/remote/repo", createdAt: 0, updatedAt: 0, state: "idle")
    }
    let endpointOnly = PilotClient()
    endpointOnly.loadFixture(projects: [], sessions: rows)
    let client = PilotClient()
    client.loadFixture(projects: [], sessions: rows)
    try hosts.install(client, host: host)
    func update(_ client: PilotClient) {
        for id in 0..<20 {
            client.handle(.session(SessionSummary(id: String(id), title: "Updated \(id)", cwd: "/remote/repo",
                createdAt: 0, updatedAt: 1, state: "working")))
        }
    }
    for _ in 0..<1000 { if !hosts.hasPendingUpdates { break }; await Task.yield() }
    try #require(!hosts.hasPendingUpdates)
    var publications = 0
    let observation = hosts.$sessions.dropFirst().sink { _ in publications += 1 }
    let baseline = ContinuousClock().measure { update(endpointOnly) }
    let start = ContinuousClock.now
    update(client)
    for _ in 0..<1000 { if !hosts.hasPendingUpdates { break }; await Task.yield() }
    try #require(!hosts.hasPendingUpdates)
    let aggregation = start.duration(to: .now)
    try await hosts.flushOffline()
    let saved = try await OfflineHostStore(directory: directory.appendingPathComponent("hosts")).load()
    #expect(publications == 1)
    #expect(saved.first?.sessions.count == 10_000)
    #expect(saved.first?.sessions.filter { $0.state == "working" }.count == 20)
    print("10k remote chats, 20 streaming updates: endpoint-only \(baseline), persistent aggregation \(aggregation), actor flush \(start.duration(to: .now))")
    withExtendedLifetime(observation) {}
    await hosts.disconnect(host)
}
