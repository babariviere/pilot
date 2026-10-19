import Foundation

/// Closed daily aggregate cells. Never retain raw events, chat IDs or event timestamps.
public struct FeatureUsageCell: Codable, Equatable, Sendable {
    public let catalogVersion: Int
    public let feature: FeatureName
    public let stage: FeatureStage
    public let availability: FeatureAvailability?
    public let outcome: FeatureOutcome?
    public let reason: FeatureReason?
    public let day: String
    public var count: Int

    public init(event: FeatureEvent, day: String, count: Int = 1) {
        catalogVersion = event.catalogVersion; feature = event.feature; stage = event.stage
        availability = event.availability; outcome = event.outcome; reason = event.reason
        self.day = day; self.count = count
    }
}
public struct FeatureUsageBatch: Codable, Sendable {
    public let schemaVersion: Int
    public let epoch: String
    public let producer: String
    public let revision: Int
    public let startedAt: String
    public let observedAt: String
    public let cells: [FeatureUsageCell]
    public let dropped: Int
    public init(epoch: String, producer: String, revision: Int, startedAt: String, observedAt: String,
                cells: [FeatureUsageCell], dropped: Int) {
        schemaVersion = 1
        self.epoch = epoch; self.producer = producer; self.revision = revision
        self.startedAt = startedAt; self.observedAt = observedAt; self.cells = cells; self.dropped = dropped
    }
}
public struct FeatureUsageSnapshot: Codable, Sendable {
    public let schemaVersion: Int
    public let host: HostRef
    public let catalogVersion: Int
    public let features: [FeatureName]
    public let scope: String
    public let status: String
    public let reason: String?
    public let collectedAt: String
    public let enabledAt: String?
    public let observedFrom: String?
    public let observedThrough: String?
    public let retentionDays: Int
    public let retainedFrom: String
    public let producerLimit: Int
    public let prunedProducers: Int
    public let dropped: Int
    public let cells: [FeatureUsageCell]
}
