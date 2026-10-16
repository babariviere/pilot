import CryptoKit
import Foundation
import PilotCore

/// A disposable relay, never an operation producer or execution owner. Daemons retain the
/// executable intents, receipts, staging pages and acknowledged cursors across app absence.
@MainActor
final class SharedContextCourier {
    @MainActor struct Endpoint {
        let token: HostConnectionToken
        let isCurrent: () -> Bool
        let summaries: () async throws -> [SharedContextSummary]
        let exchange: (String, OperationHost) async throws -> SharedExchangeBatch
        let operation: (DurableOperation, Bool) async throws -> OperationDelivery
        let acknowledge: (String, SharedExchangeAcknowledgment) async throws -> Void

        init(client: PilotClient, host: HostRef) {
            let generation = client.connectionGeneration
            token = HostConnectionToken(host: host, generation: generation)
            isCurrent = { [weak client] in
                client?.connected == true && client?.hostIdentity == host
                    && client?.connectionGeneration == generation
            }
            summaries = { [weak client] in
                guard let client else { throw HostRoutingError.disconnected }
                return try await client.sharedContexts()
            }
            exchange = { [weak client] binding, peer in
                guard let client else { throw HostRoutingError.disconnected }
                return try await client.sharedContextExchange(binding, peer: peer)
            }
            operation = { [weak client] operation, lookup in
                guard let client else { throw HostRoutingError.disconnected }
                return try await client.operation(operation, lookup: lookup)
            }
            acknowledge = { [weak client] binding, acknowledgment in
                guard let client else { throw HostRoutingError.disconnected }
                try await client.acknowledgeSharedContext(binding, acknowledgment)
            }
        }

        /// Explicit injection, with the same fences as the real transport.
        init(token: HostConnectionToken, isCurrent: @escaping () -> Bool,
             summaries: @escaping () async throws -> [SharedContextSummary],
             exchange: @escaping (String, OperationHost) async throws -> SharedExchangeBatch,
             operation: @escaping (DurableOperation, Bool) async throws -> OperationDelivery,
             acknowledge: @escaping (String, SharedExchangeAcknowledgment) async throws -> Void) {
            self.token = token; self.isCurrent = isCurrent; self.summaries = summaries
            self.exchange = exchange; self.operation = operation; self.acknowledge = acknowledge
        }
    }

    private struct Plan {
        let binding: SharedContextBinding
        let destination: HostRef
    }
    private struct Work { let plans: [Plan]? }
    private struct Running { let id: UUID; let task: Task<Void, Never> }
    private var endpoints: [HostRef: Endpoint] = [:]
    private var pending: [HostRef: Work] = [:]
    private var readyOrder: [HostRef] = []
    private var running: [HostRef: Running] = [:]
    private var epoch = UUID()
    private var stopped = false
    private(set) var failures: Set<HostRef> = []
    var isIdle: Bool { running.isEmpty && pending.isEmpty }

    /// Two exchanges in flight globally, so no individual host can receive more than two.
    /// Each task handles at most eight pages, then yields its slot to another queued host.
    static let concurrency = 2
    static let pageBudget = 8
    static let bindingBudget = 128
    static let hostBudget = 33 // Local plus the persisted index's 32 enrolled remote hosts.

    func update(_ next: [HostRef: Endpoint]) {
        guard !stopped else { return }
        guard next.count <= Self.hostBudget, next.allSatisfy({ $0.key == $0.value.token.host }) else { stop(); return }
        let previous = endpoints.mapValues(\.token)
        let incoming = next.mapValues(\.token)
        endpoints = next
        if previous != incoming { trigger() }
    }

    /// Enrollment, canonical/provisional/factual change or a verified reconnect invalidates
    /// in-flight binding snapshots. Coalesce into one fresh inventory per reachable source.
    func trigger() {
        guard !stopped else { return }
        epoch = UUID()
        for item in running.values { item.task.cancel() }
        pending = endpoints.mapValues { _ in Work(plans: nil) }
        readyOrder = endpoints.keys.sorted { $0.hostId < $1.hostId }
        failures.formIntersection(endpoints.keys)
        pump()
    }

    func stop() {
        stopped = true; epoch = UUID(); pending.removeAll(); readyOrder.removeAll(); endpoints.removeAll()
        for item in running.values { item.task.cancel() }
        // Keep cancelled jobs counted until their transports actually unwind.
    }

    private func pump() {
        guard !stopped else { return }
        while running.count < Self.concurrency,
              let index = readyOrder.firstIndex(where: { running[$0] == nil }) {
            let host = readyOrder.remove(at: index)
            guard let work = pending.removeValue(forKey: host) else { continue }
            let id = UUID(), fence = epoch
            let task = Task { [weak self] in
                guard let self else { return }
                self.failures.remove(host)
                do {
                    let continuation = try await self.run(host, work: work, epoch: fence)
                    if self.epoch == fence {
                        if let continuation, self.pending[host] == nil {
                            self.pending[host] = Work(plans: continuation)
                            self.readyOrder.append(host)
                        }
                    }
                } catch {
                    if self.epoch == fence, !(error is CancellationError) { self.failures.insert(host) }
                }
                if self.running[host]?.id == id { self.running[host] = nil }
                // No polling or retry timer. Continue only bounded, already discovered pages.
                await Task.yield()
                self.pump()
            }
            running[host] = Running(id: id, task: task)
        }
    }

    private func check(_ endpoint: Endpoint, epoch fence: UUID) throws {
        try Task.checkCancellation()
        guard !stopped, epoch == fence, endpoint.isCurrent(),
              endpoints[endpoint.token.host]?.token == endpoint.token else { throw HostRoutingError.staleGeneration }
    }

    private func inventory(_ endpoint: Endpoint, epoch: UUID) async throws -> [SharedContextSummary] {
        try check(endpoint, epoch: epoch)
        let values = try await endpoint.summaries()
        try check(endpoint, epoch: epoch)
        guard values.count <= Self.bindingBudget,
              Set(values.map { $0.binding.bindingId }).count == values.count,
              values.allSatisfy({ $0.binding.schemaVersion == 1 && $0.binding.generation > 0
                  && !$0.binding.bindingId.isEmpty && $0.binding.missionIds.count <= 256 && $0.grants.count <= 256
                  && $0.binding.peers.contains(OperationHost(endpoint.token.host)) }) else {
            throw HostRoutingError.invalidReference
        }
        return values
    }

    private func resolve(_ identity: OperationHost) -> HostRef? {
        let matches = endpoints.keys.filter { identity.matches($0) }
        // Duplicate pins are ambiguous, not permission to select the first alias or Local.
        return matches.count == 1 ? matches.first : nil
    }

    private func run(_ host: HostRef, work: Work, epoch fence: UUID) async throws -> [Plan]? {
        guard let source = endpoints[host] else { throw HostRoutingError.disconnected }
        let summaries = try await inventory(source, epoch: fence)
        var plans = work.plans ?? summaries.flatMap { summary in
            summary.binding.peers.compactMap { peer -> Plan? in
                guard let destination = resolve(peer), destination != host else { return nil }
                return Plan(binding: summary.binding, destination: destination)
            }.sorted { $0.destination.hostId < $1.destination.hostId }
        }
        // Inventories are transient per chunk, not a second app-side context replica.
        var destinationBindings: [HostRef: [SharedContextBinding]] = [:]
        var pages = 0
        while !plans.isEmpty, pages < Self.pageBudget {
            let plan = plans.removeFirst()
            pages += 1
            guard summaries.contains(where: { $0.binding == plan.binding }),
                  let destination = endpoints[plan.destination] else { continue }
            do {
                try check(source, epoch: fence); try check(destination, epoch: fence)
                if destinationBindings[plan.destination] == nil {
                    destinationBindings[plan.destination] = try await inventory(destination, epoch: fence).map(\.binding)
                }
                guard destinationBindings[plan.destination]?.contains(where: {
                    sameEnrollment($0, plan.binding)
                }) == true else { continue }
                try check(source, epoch: fence); try check(destination, epoch: fence)
                let batch = try await source.exchange(plan.binding.bindingId, OperationHost(plan.destination))
                try check(source, epoch: fence); try check(destination, epoch: fence)
                guard batch.bindingId == plan.binding.bindingId, batch.generation == plan.binding.generation,
                      batch.operations.count <= 16 else { throw HostRoutingError.invalidReference }
                var acknowledged = 0
                for operation in batch.operations {
                    try validate(operation, plan: plan, source: host)
                    try check(source, epoch: fence); try check(destination, epoch: fence)
                    var delivery = try await destination.operation(operation, true)
                    try check(source, epoch: fence); try check(destination, epoch: fence)
                    if case .unknown = delivery {
                        delivery = try await destination.operation(operation, false)
                        try check(source, epoch: fence); try check(destination, epoch: fence)
                    }
                    guard case let .receipt(receipt) = delivery else { break }
                    try receipt.validate(operation)
                    guard receipt.state != .pending else { break }
                    try await source.acknowledge(plan.binding.bindingId,
                        SharedExchangeAcknowledgment(operation: operation, receipt: receipt))
                    try check(source, epoch: fence); try check(destination, epoch: fence)
                    acknowledged += 1
                }
                // A pending/unknown head blocks its causal successors. No tight retry loop.
                if batch.more, !batch.operations.isEmpty, acknowledged == batch.operations.count { plans.append(plan) }
            } catch {
                try check(source, epoch: fence)
                // A broken binding/peer does not block unrelated enrolled exchanges.
                failures.insert(host)
            }
        }
        return plans.isEmpty ? nil : plans
    }

    private func validate(_ operation: DurableOperation, plan: Plan, source: HostRef) throws {
        guard operation.schemaVersion == 1, operation.origin == OperationHost(source).envelopeIdentity,
              operation.destination == OperationHost(plan.destination).envelopeIdentity,
              operation.bindingId == plan.binding.bindingId, operation.bindingGeneration == plan.binding.generation,
              operation.sequence > 0, !operation.operationId.isEmpty,
              operation.kind.hasPrefix("share-"),
              operation.payload.utf8.count <= 64 * 1024,
              (try JSONEncoder().encode(operation)).count <= 64 * 1024,
              SHA256.hash(data: Data(operation.payload.utf8)).map({ String(format: "%02x", $0) }).joined() == operation.payloadHash
        else { throw HostRoutingError.invalidReference }
    }

    private func sameEnrollment(_ lhs: SharedContextBinding, _ rhs: SharedContextBinding) -> Bool {
        // Revocation itself must reach an active peer. The daemon ledger decides which
        // operations remain admissible, including cancellation and late factual evidence.
        lhs.schemaVersion == rhs.schemaVersion && lhs.bindingId == rhs.bindingId && lhs.generation == rhs.generation
            && lhs.logicalProjectId == rhs.logicalProjectId && lhs.memoryHome == rhs.memoryHome
            && lhs.missionHome == rhs.missionHome && lhs.executionProject == rhs.executionProject
            && lhs.missionIds == rhs.missionIds && lhs.shareMemory == rhs.shareMemory
    }
}
