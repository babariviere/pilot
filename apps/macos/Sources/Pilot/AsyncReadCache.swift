import Foundation

/// Short-lived, bounded, single-flight reads. Cancellation of one caller never cancels other readers.
@MainActor
final class AsyncReadCache<Key: Hashable, Value: Sendable> {
    private struct Entry {
        let value: Value
        let expires: Date
        let order: Int
    }
    private var entries: [Key: Entry] = [:]
    @MainActor private final class Flight {
        var task: Task<Void, Never>?
        var readers: [UUID: CheckedContinuation<Value, Error>] = [:]
    }
    private var pending: [Key: Flight] = [:]
    private var order = 0
    private let ttl: TimeInterval
    private let limit: Int
    private let now: () -> Date

    init(ttl: TimeInterval, limit: Int = 128, now: @escaping () -> Date = Date.init) {
        self.ttl = ttl
        self.limit = max(1, limit)
        self.now = now
    }

    func value(for key: Key, load: @escaping () async throws -> Value) async throws -> Value {
        try Task.checkCancellation()
        if let entry = entries[key], entry.expires > now() { return entry.value }
        let flight = pending[key] ?? Flight()
        pending[key] = flight
        let reader = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Value, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                    if flight.readers.isEmpty, pending[key] === flight { pending[key] = nil }
                    return
                }
                flight.readers[reader] = continuation
                guard flight.task == nil else { return }
                flight.task = Task {
                    do {
                        let value = try await load()
                        complete(.success(value), key: key, flight: flight)
                    } catch { complete(.failure(error), key: key, flight: flight) }
                }
            }
        } onCancel: {
            Task { @MainActor in self.cancel(reader, key: key, flight: flight) }
        }
    }

    private func complete(_ result: Result<Value, Error>, key: Key, flight: Flight) {
        if pending[key] === flight {
            pending[key] = nil
            if case let .success(value) = result {
                order += 1
                entries[key] = Entry(value: value, expires: now().addingTimeInterval(ttl), order: order)
                while entries.count > limit, let oldest = entries.min(by: { $0.value.order < $1.value.order }) {
                    entries[oldest.key] = nil
                }
            }
        }
        let readers = flight.readers.values
        flight.readers = [:]
        flight.task = nil
        for reader in readers { reader.resume(with: result) }
    }

    private func cancel(_ reader: UUID, key: Key, flight: Flight) {
        flight.readers.removeValue(forKey: reader)?.resume(throwing: CancellationError())
        if flight.readers.isEmpty {
            if pending[key] === flight { pending[key] = nil }
            // No mounted row needs this request. Also releases a queued limiter slot promptly.
            flight.task?.cancel()
        }
    }

    func readerCount(for key: Key) -> Int { pending[key]?.readers.count ?? 0 }

    func invalidate(_ key: Key) {
        entries[key] = nil
        // Existing readers still receive their result, but it cannot repopulate the cache.
        pending[key] = nil
    }
}
