import Foundation
import PilotCore

/// Scheduling only. The wire adapter owns receipt-first exchange, journal cursors and page bounds;
/// daemons own durable intents, authorization, deduplication and acknowledgments. No timers or retries.
@MainActor
final class ControlCourierScheduler {
    struct Fence {
        let check: () throws -> Void
    }

    struct Endpoint {
        let home: HostConnectionToken
        let target: HostConnectionToken
        let isCurrent: () -> Bool
        /// One bounded exchange. Return true only after committed progress with more known work,
        /// never for pending/unknown receipts, failed imports or speculative retry.
        /// Check the fence before each side effect and after every suspension.
        let exchange: (Fence) async throws -> Bool
        var revision: UUID? = nil
    }

    private struct Running {
        let id: UUID
        let task: Task<Void, Never>
    }
    private struct Registration {
        let id: UUID
        let endpoint: Endpoint
    }

    static let concurrency = 2
    static let pageBudget = 8
    static let hostBudget = 32
    private let concurrencyLimit: Int
    init(concurrency: Int = 2) { concurrencyLimit = max(1, min(concurrency, Self.concurrency)) }

    private var endpoints: [HostRef: Registration] = [:]
    private var running: [HostRef: Running] = [:]
    private var ready: [HostRef] = []
    private var pending: Set<HostRef> = []
    private var stopped = false
    private(set) var failures: Set<HostRef> = []
    var isIdle: Bool { running.isEmpty && pending.isEmpty }

    /// Only the verified lifecycle adapter supplies endpoints. A replacement invalidates old work
    /// synchronously, but keeps its occupied slot until cancellation actually unwinds.
    func update(_ next: [HostRef: Endpoint]) throws {
        guard !stopped else { return }
        let homes = next.values.map(\.home)
        let pins = next.keys.map { [$0.daemonId, $0.lineageId] }
        guard next.count <= Self.hostBudget,
              next.allSatisfy({ host, endpoint in
                  let home = endpoint.home.host
                  return host == endpoint.target.host && !host.hostId.isEmpty
                      && !host.daemonId.isEmpty && !host.lineageId.isEmpty
                      && !home.hostId.isEmpty && !home.daemonId.isEmpty && !home.lineageId.isEmpty
                      && (host.daemonId != home.daemonId || host.lineageId != home.lineageId)
              }),
              homes.allSatisfy({ $0 == homes.first }), Set(pins).count == pins.count,
              Set(next.keys.map(\.hostId)).count == next.count else {
            stop()
            throw HostRoutingError.invalidReference
        }

        for host in Array(endpoints.keys) where next[host] == nil {
            endpoints[host] = nil
            running[host]?.task.cancel()
            pending.remove(host)
            ready.removeAll { $0 == host }
            failures.remove(host)
        }
        for host in next.keys.sorted(by: { $0.hostId < $1.hostId }) {
            guard let endpoint = next[host] else { continue }
            let previous = endpoints[host]
            if let previous, previous.endpoint.home == endpoint.home, previous.endpoint.target == endpoint.target,
               previous.endpoint.revision == endpoint.revision {
                // Refresh closures without changing the generation or scheduling duplicate work.
                endpoints[host] = Registration(id: previous.id, endpoint: endpoint)
                continue
            }
            endpoints[host] = Registration(id: UUID(), endpoint: endpoint)
            running[host]?.task.cancel()
            enqueue(host)
        }
        pump()
    }

    /// A durable-outbox/journal/status change schedules at most one follow-up per host. Changes
    /// during an exchange do not abort it or lose the follow-up. Offline hosts are never queued.
    func changed(_ host: HostRef? = nil) {
        guard !stopped else { return }
        if let host { enqueue(host) }
        else {
            for host in endpoints.keys.sorted(by: { $0.hostId < $1.hostId }) { enqueue(host) }
        }
        pump()
    }

    func stop() {
        stopped = true
        endpoints.removeAll()
        ready.removeAll()
        pending.removeAll()
        failures.removeAll()
        for item in running.values { item.task.cancel() }
    }

    func stopAndWait() async {
        stop()
        let tasks = running.values.map(\.task)
        for task in tasks { await task.value }
    }

    private func enqueue(_ host: HostRef) {
        guard endpoints[host] != nil, pending.insert(host).inserted else { return }
        ready.append(host)
    }

    private func check(_ host: HostRef, registration: Registration, run: UUID) throws {
        try Task.checkCancellation()
        guard !stopped, endpoints[host]?.id == registration.id, running[host]?.id == run,
              registration.endpoint.isCurrent() else { throw HostRoutingError.staleGeneration }
    }

    private func pump() {
        guard !stopped else { return }
        while running.count < concurrencyLimit,
              let index = ready.firstIndex(where: { running[$0] == nil }) {
            let host = ready.remove(at: index)
            pending.remove(host)
            guard let registration = endpoints[host] else { continue }
            let id = UUID()
            let task = Task { [self] in
                var more = false
                do {
                    let fence = Fence { [weak self] in
                        guard let self else { throw HostRoutingError.disconnected }
                        try self.check(host, registration: registration, run: id)
                    }
                    for _ in 0..<Self.pageBudget {
                        try fence.check()
                        more = try await registration.endpoint.exchange(fence)
                        try fence.check()
                        if !more { break }
                    }
                    if endpoints[host]?.id == registration.id {
                        failures.remove(host)
                        if more { enqueue(host) }
                    }
                } catch {
                    if !stopped, endpoints[host]?.id == registration.id,
                       !(error is CancellationError) { failures.insert(host) }
                }
                // Keep cancelled transports counted until every suspended exchange has returned.
                if running[host]?.id == id { running[host] = nil }
                await Task.yield()
                pump()
            }
            running[host] = Running(id: id, task: task)
        }
    }
}
