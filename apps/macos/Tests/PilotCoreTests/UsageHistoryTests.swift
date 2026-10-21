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
