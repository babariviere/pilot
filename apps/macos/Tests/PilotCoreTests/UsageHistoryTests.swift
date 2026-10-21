import Foundation
import Testing
@testable import PilotCore

@Test func usageHistorySharedFixtureRoundTripsWithoutInventingLegacyProvenance() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let data = try Data(contentsOf: root.appendingPathComponent("packages/protocol/fixtures/usage-history.json"))
    let page = try JSONDecoder().decode(UsageHistoryPage.self, from: data)
    #expect(page.rows.count == 2)
    #expect(page.rows[0].physicalModel?.model == "example-model-1")
    #expect(page.rows[0].virtualModel?.provider == "pi-virtual")
    #expect(page.rows[0].attribution?.mission?.lineageId == "77777777-7777-4777-8777-777777777777")
    #expect(page.rows[0].cost?.estimatedUsdMicros == 1234)
    #expect(page.rows[0].retries == 1)
    #expect(page.rows[0].outcome == "success")
    #expect(page.rows[0].attribution?.attemptId == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    #expect(page.rows[0].parent?.operationId == "tool:17")
    #expect(page.rows[0].virtualRevision == "observed-v1")
    #expect(page.rows[1].completedAt == nil)
    #expect(page.rows[1].physicalModel == nil)
    #expect(page.rows[1].attribution == nil)
    #expect(page.rows[1].tokens?.reasoning == nil)
    #expect(page.rows[1].cost?.estimatedUsdMicros == nil)
    #expect(page.status.coverage == "partial")
    let encoded = try JSONEncoder().encode(page)
    let decoded = try JSONDecoder().decode(UsageHistoryPage.self, from: encoded)
    #expect(decoded == page)
    let original = try JSONSerialization.jsonObject(with: data) as? NSDictionary
    let roundTrip = try JSONSerialization.jsonObject(with: encoded) as? NSDictionary
    #expect(roundTrip == original)
}

@Test func usageHistoryUnknownResponseDoesNotInventZeroUsage() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let data = try Data(contentsOf: root.appendingPathComponent("packages/protocol/fixtures/usage-history-unknown.json"))
    let row = try JSONDecoder().decode(UsageObservation.self, from: data)
    #expect(row.tokens == nil)
    #expect(row.cost == nil)
    #expect(row.completedAt == nil)
    #expect(row.outcome == "unknown")
    let encoded = try JSONEncoder().encode(row)
    let roundTrip = try JSONSerialization.jsonObject(with: encoded) as? NSDictionary
    let original = try JSONSerialization.jsonObject(with: data) as? NSDictionary
    #expect(roundTrip == original)
}

@Test func usageAnalyticsSharedFixturesPreserveUnknownClassesAndNonAdditiveCheckpoints() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let data = try Data(contentsOf: root.appendingPathComponent("packages/protocol/fixtures/usage-analytics.json"))
    let result = try JSONDecoder().decode(UsageAnalyticsResult.self, from: data)
    #expect(result.total.records == 2)
    #expect(result.total.metrics["input"]?.value == 100)
    #expect(result.total.metrics["input"]?.unknown == 1)
    #expect(result.total.metrics["reasoning"]?.unknown == 1)
    #expect(result.total.metrics["billedUsdMicros"]?.value == nil)
    #expect(result.reconciliation.records == 1)
    #expect(result.reconciliation.metrics.values.allSatisfy { $0.value == nil })
    #expect(result.reconciliation.metrics["input"]?.unknown == 1)
    let encoded = try JSONEncoder().encode(result)
    let roundTrip = try JSONSerialization.jsonObject(with: encoded) as? NSDictionary
    let original = try JSONSerialization.jsonObject(with: data) as? NSDictionary
    #expect(roundTrip == original)

    let queryData = try Data(contentsOf: root.appendingPathComponent("packages/protocol/fixtures/usage-query.json"))
    let query = try JSONDecoder().decode(UsageAnalyticsQuery.self, from: queryData)
    #expect(query.filters?.mission?.homeId == "66666666-6666-4666-8666-666666666666")
    #expect(query.filters?.virtualRevision == "observed-v1")
    let queryEncoded = try JSONEncoder().encode(query)
    let queryRoundTrip = try JSONSerialization.jsonObject(with: queryEncoded) as? NSDictionary
    let originalQuery = try JSONSerialization.jsonObject(with: queryData) as? NSDictionary
    #expect(queryRoundTrip == originalQuery)
}

@Test func usageProjectionPlansDeduplicateAliasesButNeverMissionsOrDistinctExecutionSources() {
    let local = HostRef(hostId: "local", daemonId: "A", lineageId: "1")
    let alias = HostRef(hostId: "alias", daemonId: "a", lineageId: "1")
    let remote = HostRef(hostId: "box", daemonId: "B", lineageId: "2")
    let offline = HostRef(hostId: "offline", daemonId: "C", lineageId: "3")
    let plan = UsageProjectionPlan(hosts: [alias, remote, local, offline, local], connected: [local, remote])
    #expect(plan.hosts.count == 4)
    #expect(plan.hosts.filter { $0.state == "fresh" }.map(\.host) == [local, remote])
    #expect(plan.hosts.first { $0.host == alias }?.state == "alias")
    #expect(plan.hosts.first { $0.host == offline }?.state == "disconnected")
    #expect(plan.omittedHosts == 0)
    let many = (0..<50).map { HostRef(hostId: "box\($0)", daemonId: "d\($0)", lineageId: "l") }
    let bounded = UsageProjectionPlan(hosts: many, connected: [])
    #expect(bounded.hosts.count == 32)
    #expect(bounded.omittedHosts == 18)
}
