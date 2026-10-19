import Foundation
import PilotCore
import PilotTelemetry
import Testing

private final class FeatureClock: @unchecked Sendable {
    let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_792_411_200)
    func now() -> Date { lock.withLock { date } }
    func advance(_ seconds: TimeInterval) { lock.withLock { date = date.addingTimeInterval(seconds) } }
}

@Test func localFeatureUsageWorksWithRemoteExportOffAndNeverRetainsRawEvents() throws {
    let clock = FeatureClock()
    let collector = LocalFeatureUsage(now: { clock.now() })
    let telemetry = PilotTelemetry(configuration: .disabled, localFeatureUsage: collector)
    telemetry.recordFeature(.attempt(.diagnoseChat))
    #expect(collector.snapshot() == nil, "collection defaults off independently from uploads")
    collector.configure(enabled: true, epoch: UUID().uuidString)
    telemetry.recordFeature(.eligibility(.diagnoseChat, .available))
    telemetry.recordFeature(.eligibility(.diagnoseChat, .available))
    telemetry.recordFeature(.exposure(.diagnoseChat))
    telemetry.recordFeature(.exposure(.diagnoseChat))
    telemetry.recordFeature(.attempt(.diagnoseChat))
    telemetry.recordFeature(try #require(FeatureEvent.outcome(.diagnoseChat, .success, reason: .none)))
    let batch = try #require(collector.snapshot())
    #expect(batch.cells.count == 4)
    #expect(batch.cells.allSatisfy { $0.count == 1 })
    #expect(telemetry.stats.started == 0, "local counts never require or create OTLP spans")
    let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(batch))
    #expect(json["events"] == nil && json["sessionId"] == nil && json["analyticsId"] == nil)
    #expect(json["cells"]?.array?.allSatisfy { $0["at"] == nil && $0["title"] == nil } == true)
    clock.advance(8 * 86_400)
    #expect(collector.snapshot()?.cells.isEmpty == true, "seven UTC days, not indefinite app lifetime")
    collector.configure(enabled: false, epoch: nil)
    #expect(collector.snapshot() == nil)
}

@Test func localFeatureUsageCapsDailyWorkAndClearEpochDiscardsPendingAggregates() throws {
    let collector = LocalFeatureUsage()
    let first = UUID().uuidString
    collector.configure(enabled: true, epoch: first)
    for _ in 0..<10_020 { collector.record(.attempt(.devboxChat)) }
    let capped = try #require(collector.snapshot())
    #expect(capped.cells.count == 1 && capped.cells.first?.count == 10_000)
    #expect(capped.dropped == 20)
    let next = UUID().uuidString
    collector.configure(enabled: true, epoch: next)
    let cleared = try #require(collector.snapshot())
    #expect(cleared.epoch != capped.epoch && cleared.producer != capped.producer)
    #expect(cleared.cells.isEmpty && cleared.dropped == 0)
    collector.configure(enabled: true, epoch: "not-an-epoch")
    #expect(collector.snapshot() == nil, "unverified configuration cannot enable collection")
}
