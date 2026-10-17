import Foundation
import PilotCore
import PilotTelemetry

/// One idle send journey. It stores row identity only, never message or response content.
@MainActor
final class MessageSendTelemetry {
    private let root: PilotTelemetrySpan
    private let baseline: Set<String>
    private let expectsVisibleResponse: Bool
    private var finished = false

    init(rows: [ChatRow], expectsVisibleResponse: Bool) {
        baseline = Set(rows.map(\.id))
        self.expectsVisibleResponse = expectsVisibleResponse
        root = PilotTelemetry.shared.startSpan(.messageSend, attributes: [
            .operation(.messageSend), .progressKind(.none),
        ])
    }

    func performAPI<Value>(_ operation: () async throws -> Value) async throws -> Value {
        let api = PilotTelemetry.shared.startSpan(.messageSend, attributes: [
            .operation(.messageSend), .phase(.api), .progressKind(.none),
        ], parent: root.carrier)
        do {
            let value = try await PilotTraceContext.$current.withValue(api.carrier ?? root.carrier) {
                try await operation()
            }
            api.finish()
            if !expectsVisibleResponse { finish(.unavailable, reason: .waiting) }
            return value
        } catch {
            api.finish(error is CancellationError ? .cancelled : .failed)
            finish(error is CancellationError ? .cancelled : .failed)
            throw error
        }
    }

    /// Called in the frame-paced publication transaction. `unsupported` is honest: this seam observes model
    /// publication, not Core Animation presentation, especially while a window is occluded or the display sleeps.
    func published(_ rows: [ChatRow]) -> Bool {
        guard !finished, expectsVisibleResponse,
              let visibleResult = Self.firstProgress(in: rows, excluding: baseline) else { return finished }
        let (progress, outcome) = visibleResult
        let publication = PilotTelemetry.shared.startSpan(.messageSend, attributes: [
            .operation(.messageSend), .phase(.publication), .progressKind(progress),
        ], parent: root.carrier)
        publication.finish(outcome)
        let visible = PilotTelemetry.shared.startSpan(.messageSend, attributes: [
            .operation(.messageSend), .phase(.firstVisible), .progressKind(progress),
            .frameObservation(.unsupported),
        ], parent: root.carrier)
        visible.finish(outcome)
        finish(outcome)
        return true
    }

    func cancel(_ outcome: PilotTelemetryOutcome = .unavailable, reason: PilotTelemetryReason = .unknown) {
        finish(outcome, reason: reason)
    }

    private func finish(_ outcome: PilotTelemetryOutcome = .completed, reason: PilotTelemetryReason? = nil) {
        guard !finished else { return }
        finished = true
        root.finish(outcome, reason: reason)
    }

    static func firstProgress(
        in rows: [ChatRow],
        excluding baseline: Set<String>
    ) -> (PilotProgressKind, PilotTelemetryOutcome)? {
        for row in rows where !baseline.contains(row.id) {
            for visible in row.unfolded {
                switch visible {
                case let .text(_, text, _) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                    return (.text, .completed)
                case let .thinking(_, text, _) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                    return (.thinking, .completed)
                case let .tools(_, items) where !items.isEmpty:
                    return (.tool, .completed)
                case .question, .artifact:
                    return (.tool, .completed)
                case .error:
                    return (.none, .failed)
                default:
                    continue
                }
            }
        }
        return nil
    }
}
