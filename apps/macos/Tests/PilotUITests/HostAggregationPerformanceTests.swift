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
    let hosts = ClientDirectory()
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
