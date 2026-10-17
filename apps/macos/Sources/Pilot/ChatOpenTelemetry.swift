import Foundation
import PilotCore
import PilotTelemetry

/// One chat-selection journey. It observes prepared row counts and event envelopes only, never transcript content.
@MainActor
final class ChatOpenTelemetry {
    private let telemetry: PilotTelemetry
    private let root: PilotTelemetrySpan
    private let cold: Bool
    private var historyBucket: PilotHistoryBucket
    private var api: PilotTelemetrySpan?
    private var reduction: PilotTelemetrySpan?
    private var publication: PilotTelemetrySpan?
    private var receivedFirstBatch = false
    private var reducedFirstBatch = false
    private var finished = false

    init(cachedRowCount: Int, telemetry: PilotTelemetry = .shared) {
        self.telemetry = telemetry
        cold = cachedRowCount == 0
        historyBucket = Self.historyBucket(entryCount: cachedRowCount)
        root = telemetry.startSpan(.chatOpen, attributes: [
            .operation(.chatOpen), .cold(cold), .historyBucket(historyBucket),
        ])
    }

    func beginAPI() -> PilotTraceCarrier? {
        guard !finished, api == nil else { return api?.carrier ?? root.carrier }
        api = telemetry.startSpan(.chatOpen, attributes: [
            .operation(.chatOpen), .phase(.api), .cold(cold),
        ], parent: root.carrier)
        return api?.carrier ?? root.carrier
    }

    /// The dedicated stream's first event batch is the API boundary and the start of transcript reduction.
    func received(_ events: [JSONValue]) {
        guard !finished, !receivedFirstBatch else { return }
        receivedFirstBatch = true
        if let observed = Self.historyBucket(events: events) {
            historyBucket = observed
            root.setAttribute(.historyBucket(observed))
        }
        api?.finish()
        api = nil
        reduction = telemetry.startSpan(.chatOpen, attributes: [
            .operation(.chatOpen), .phase(.reduction), .cold(cold), .historyBucket(historyBucket),
        ], parent: root.carrier)
    }

    func reduced(_ outcome: PilotTelemetryOutcome = .completed) {
        guard !finished, receivedFirstBatch, !reducedFirstBatch else { return }
        reducedFirstBatch = true
        reduction?.finish(outcome)
        reduction = nil
        guard outcome == .completed else { finish(outcome); return }
        publication = telemetry.startSpan(.chatOpen, attributes: [
            .operation(.chatOpen), .phase(.publication), .cold(cold), .historyBucket(historyBucket),
        ], parent: root.carrier)
    }

    /// Called from the frame-paced model publication transaction. This does not claim Core Animation display.
    func published(loaded: Bool, failed: Bool = false) -> Bool {
        guard !finished, loaded else { return false }
        let outcome: PilotTelemetryOutcome = failed ? .failed : .completed
        if publication == nil {
            publication = telemetry.startSpan(.chatOpen, attributes: [
                .operation(.chatOpen), .phase(.publication), .cold(cold), .historyBucket(historyBucket),
            ], parent: root.carrier)
        }
        publication?.finish(outcome)
        publication = nil
        let first = telemetry.startSpan(.chatOpen, attributes: [
            .operation(.chatOpen), .phase(.firstTranscript), .cold(cold),
            .historyBucket(historyBucket), .frameObservation(.unsupported),
        ], parent: root.carrier)
        first.finish(outcome)
        finish(outcome)
        return true
    }

    func cancel(_ outcome: PilotTelemetryOutcome = .unavailable, reason: PilotTelemetryReason = .unknown) {
        guard !finished else { return }
        api?.finish(outcome, reason: reason)
        reduction?.finish(outcome, reason: reason)
        publication?.finish(outcome, reason: reason)
        finish(outcome, reason: reason)
    }

    private func finish(_ outcome: PilotTelemetryOutcome, reason: PilotTelemetryReason? = nil) {
        guard !finished else { return }
        finished = true
        api = nil
        reduction = nil
        publication = nil
        root.finish(outcome, reason: reason)
    }

    static func historyBucket(entryCount: Int) -> PilotHistoryBucket {
        switch max(0, entryCount) {
        case 0: .empty
        case 1 ... 100: .small
        case 101 ... 1_000: .medium
        default: .large
        }
    }

    static func historyBucket(events: [JSONValue]) -> PilotHistoryBucket? {
        for event in events where event["type"]?.string == "snapshot" {
            let count = event["historyCount"]?.int ?? event["entries"]?.array?.count ?? 0
            return historyBucket(entryCount: count)
        }
        return nil
    }
}
