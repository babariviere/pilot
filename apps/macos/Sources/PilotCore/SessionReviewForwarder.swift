import Foundation

/// Serial, coalesced delivery of review high-water marks. Local attention state stays authoritative
/// for the chat UI even if pilotd is unavailable. No polling: failures retry on the next review or
/// connection snapshot, and persisted marks are backfilled again on the next launch.
@MainActor
public final class SessionReviewForwarder {
    private let send: @MainActor (ReviewRequest) async throws -> Void
    // At most one pending mark per reviewed chat, not one per review event. Requests are capped at 1000.
    private var pending: [String: Double] = [:]
    private var backfilled = false
    private(set) var task: Task<Void, Never>?

    public init(send: @escaping @MainActor (ReviewRequest) async throws -> Void) {
        self.send = send
    }

    public func review(_ mark: ReviewRequest.Mark) {
        merge(mark)
        flush()
    }

    /// Call after a connection snapshot. Only the first snapshot collects the launch backfill.
    public func connected(backfill: @MainActor () async -> [ReviewRequest.Mark]) async {
        if !backfilled {
            backfilled = true
            for mark in await backfill().prefix(ReviewRequest.maxMarks) { merge(mark) }
        }
        flush()
    }

    private func merge(_ mark: ReviewRequest.Mark) {
        guard mark.outcomeAt.isFinite else { return }
        pending[mark.sessionId] = max(pending[mark.sessionId] ?? mark.outcomeAt, mark.outcomeAt)
    }

    private func flush() {
        guard task == nil, !pending.isEmpty else { return }
        task = Task { [self] in
            defer { task = nil }
            while !pending.isEmpty {
                let marks = pending.prefix(ReviewRequest.maxMarks).map {
                    ReviewRequest.Mark(sessionId: $0.key, outcomeAt: $0.value)
                }
                do { try await send(ReviewRequest(marks: marks)) }
                catch { return }
                // A newer review may have arrived while this request was in flight.
                for mark in marks where pending[mark.sessionId] == mark.outcomeAt {
                    pending[mark.sessionId] = nil
                }
            }
        }
    }
}
