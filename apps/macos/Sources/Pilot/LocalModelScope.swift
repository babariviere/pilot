import Combine
import Foundation
import PilotCore

/// Presentation of pi’s Local model settings, not a distributed model registry.
/// These are not encoded or used as an alternate HTTP contract.
struct ScopedModelsObservation: Sendable {
    struct Candidate: Identifiable, Equatable, Sendable {
        let id: String
        let provider: String
        let name: String
    }
    struct Resolution: Sendable {
        let pattern: String
        let matches: [String]
        let reason: String?
    }
    let baseline: ScopedModelsBaseline
    var candidates: [Candidate] = []
    var resolution: [Resolution] = []
    var writable = true
}

@MainActor final class LocalModelScope: ObservableObject {
    struct Endpoint {
        let token: HostConnectionToken
        let read: () async throws -> ScopedModelsObservation
        let write: (ScopedModelsSelection, String) async throws -> Void
        let isCurrent: () -> Bool
    }

    struct Consent: Equatable, Sendable {
        let host: HostRef
        let baseline: ScopedModelsBaseline
        let revision: UInt64
        let desired: ScopedModelsSelection
        let token: HostConnectionToken
    }

    @Published private(set) var state = ScopedModelsState()
    @Published private(set) var observations: [HostRef: ScopedModelsObservation] = [:]
    @Published private(set) var checking: Set<HostRef> = []
    @Published private(set) var problem: String?
    private let store: ScopedModelsStore
    private var endpoint: Endpoint?
    private var task: Task<Void, Never>?
    private var pending = false
    private var ready = false
    private var loading = false
    private var stopped = false
    private var startup: Task<Void, Never>?
    var isIdle: Bool { !pending && task == nil && !loading && startup == nil }

    init(store: ScopedModelsStore) { self.store = store }

    func start() async {
        guard !ready, !loading, !stopped else { return }
        loading = true
        defer { loading = false }
        do {
            let saved = try await store.load()
            guard !stopped else { return }
            publish(saved)
            ready = true
            pending = endpoint != nil
            drain()
        } catch { storageFailed() }
    }

    /// Only the Local daemon can be admitted. A replacement waits for any cancelled read/write to unwind.
    func update(_ value: Endpoint?) {
        guard !stopped else { return }
        let value = value?.token.host.hostId == "local" ? value : nil
        guard endpoint?.token != value?.token else { return }
        task?.cancel()
        observations = [:]
        endpoint = value
        pending = value != nil
        if ready { drain() }
        else if startup == nil {
            startup = Task { [weak self] in
                guard let self else { return }
                await self.start()
                self.startup = nil
            }
        }
    }

    func refresh() { pending = endpoint != nil; drain() }

    func save(_ selection: ScopedModelsSelection, on host: HostRef, baseline: ScopedModelsBaseline? = nil) async {
        guard host.hostId == "local" else { return }
        do {
            try selection.validate()
            problem = nil
            publish(try await store.update { try $0.save(selection, on: host, baseline: baseline) })
            pending = endpoint != nil
            drain()
        } catch ScopedModelsFailure.invalidSelection {
            problem = "Choose All, or 1–256 literal patterns of at most 256 UTF-8 bytes each."
        } catch { storageFailed() }
    }

    func review(_ host: HostRef) -> Consent? {
        guard let desired = state.desired, let endpoint, endpoint.token.host == host, endpoint.isCurrent(),
              let observation = observations[host] else { return nil }
        return Consent(host: host, baseline: observation.baseline, revision: state.revision,
                       desired: desired, token: endpoint.token)
    }

    func isCurrent(_ consent: Consent) -> Bool {
        !stopped && state.revision == consent.revision && state.desired == consent.desired &&
            observations[consent.host]?.baseline == consent.baseline &&
            endpoint?.token == consent.token && endpoint?.isCurrent() == true
    }

    func join(_ consent: Consent) async {
        // Consent covers the exact host value, desired revision and verified connection shown.
        guard isCurrent(consent) else { return }
        do {
            publish(try await store.update {
                guard $0.revision == consent.revision else { throw ScopedModelsFailure.stale }
                try $0.join(consent.host, baseline: consent.baseline)
            })
            refresh()
        } catch ScopedModelsFailure.stale {
        } catch { storageFailed() }
    }

    func leave(_ host: HostRef) async {
        guard host.hostId == "local" else { return }
        do { publish(try await store.update { $0.leave(host) }); pending = false }
        catch { storageFailed() }
    }

    func useCurrent(_ consent: Consent) async {
        guard isCurrent(consent) else { return }
        // A new intent, NOT permission to rebase other hosts' established CAS baselines.
        do {
            publish(try await store.update {
                guard $0.revision == consent.revision else { throw ScopedModelsFailure.stale }
                try $0.save(consent.baseline.selection, on: consent.host)
            })
            pending = endpoint != nil
            drain()
        } catch ScopedModelsFailure.stale {
        } catch { storageFailed() }
    }

    func stop() {
        stopped = true; pending = false; endpoint = nil
        task?.cancel()
    }

    func stopAndWait() async {
        stop()
        await startup?.value
        await task?.value
        await store.settled()
    }

    private func publish(_ value: ScopedModelsState) {
        if value.sequence >= state.sequence { state = value }
    }

    private func storageFailed() {
        problem = "Scoped-model preferences could not be saved or read. Existing data was kept; no unconfirmed intent will be sent."
        ready = false
    }

    private func current(_ endpoint: Endpoint) -> Bool {
        !stopped && !Task.isCancelled && self.endpoint?.token == endpoint.token && endpoint.isCurrent()
    }

    private func drain() {
        guard ready, !stopped, pending, task == nil, let endpoint else { return }
        pending = false
        let host = endpoint.token.host
        checking = [host]
        task = Task { [weak self] in
            guard let self else { return }
            await self.reconcile(endpoint)
            self.checking = []
            self.task = nil
            self.drain()
        }
    }

    private func record(_ endpoint: Endpoint, revision: UInt64? = nil,
                        decision: UUID? = nil,
                        _ edit: @escaping @Sendable (inout ScopedModelsHostState) -> Void) async throws {
        guard current(endpoint) else { throw ScopedModelsFailure.stale }
        let host = endpoint.token.host
        let value = try await store.update { state in
            if let revision, state.revision != revision { throw ScopedModelsFailure.stale }
            if let decision, state.entry(host)?.decision != decision { throw ScopedModelsFailure.stale }
            state.edit(host, edit)
        }
        guard current(endpoint) else { throw ScopedModelsFailure.stale }
        publish(value)
    }

    private func reconcile(_ endpoint: Endpoint) async {
        let host = endpoint.token.host
        var expectedRevision: UInt64?
        var expectedDecision: UUID?
        do {
            let starting = try await store.load()
            expectedRevision = starting.revision
            let observation = try await endpoint.read()
            guard current(endpoint) else { return }
            observations[host] = observation
            let observed = observation.baseline
            let unresolved = observation.resolution.compactMap { value in
                value.reason.map { ScopedModelsHostState.Unresolved(pattern: value.pattern, reason: $0) }
            }
            try await record(endpoint, revision: starting.revision) { $0.observed = observed; $0.unresolved = unresolved }
            let saved = try await store.load()
            guard current(endpoint), let desired = saved.desired,
                  let entry = saved.entry(host), entry.participates, entry.status != .divergent else { return }
            let revision = saved.revision
            guard revision == starting.revision else { throw ScopedModelsFailure.stale }
            let decision = entry.decision
            expectedDecision = decision
            if observed.patterns == desired.patterns {
                try await record(endpoint, revision: revision, decision: decision) {
                    $0.status = .synced; $0.appliedRevision = revision; $0.appliedHash = observed.hash
                    $0.baseline = observed; $0.attempt = nil
                }
                return
            }
            guard observation.writable else {
                try await record(endpoint, revision: revision, decision: decision) { $0.status = .readOnly }
                return
            }
            guard let baseline = entry.baseline else { return }
            guard observed.hash == baseline.hash else {
                try await record(endpoint, revision: revision, decision: decision) { $0.status = .conflict }
                return
            }
            // A conflict stays held until explicit overwrite or leave, even if another edit
            // later happens to restore its old hash. Never silently unpause a user's decision.
            guard entry.status != .conflict else { return }
            let previous = entry.attempt.flatMap { $0.revision == revision ? $0 : nil }
            guard (previous?.sends ?? 0) < 2 else {
                try await record(endpoint, revision: revision, decision: decision) { $0.status = .failed }
                return
            }
            let attempt = ScopedModelsHostState.Attempt(id: previous?.id ?? UUID(), revision: revision,
                selection: desired, expectedHash: baseline.hash, sends: (previous?.sends ?? 0) + 1)
            // Atomically persist the exact intent/CAS and retry count BEFORE the PUT.
            try await record(endpoint, revision: revision, decision: decision) { $0.attempt = attempt; $0.status = .applying }
            guard current(endpoint) else { return }
            do {
                try await endpoint.write(desired, attempt.expectedHash)
            } catch ScopedModelsFailure.conflict {
                try await record(endpoint, revision: revision, decision: decision) { $0.status = .conflict }
                // Read the latest value for a new explicit conflict decision, never rebase.
                let latest = try await endpoint.read()
                guard current(endpoint) else { return }
                observations[host] = latest
                try await record(endpoint, revision: revision, decision: decision) { $0.observed = latest.baseline }
                return
            } catch ScopedModelsFailure.unsupported { throw ScopedModelsFailure.unsupported
            } catch ScopedModelsFailure.readOnly { throw ScopedModelsFailure.readOnly
            } catch ScopedModelsFailure.nativeActionRequired { throw ScopedModelsFailure.nativeActionRequired
            } catch ScopedModelsFailure.invalidSelection { throw ScopedModelsFailure.invalidSelection
            } catch {
                // Lost acknowledgment: lookup before any bounded retry. Never use a new hash.
                guard current(endpoint) else { return }
            }
            let readback = try await endpoint.read()
            guard current(endpoint) else { return }
            observations[host] = readback
            if readback.baseline.patterns == desired.patterns {
                try await applied(endpoint, attempt: attempt, decision: decision, baseline: readback.baseline)
            } else {
                try await record(endpoint, revision: revision, decision: decision) {
                    $0.observed = readback.baseline
                    $0.status = readback.baseline.hash == baseline.hash ? (attempt.sends < 2 ? .pending : .failed) : .conflict
                }
                // One bounded value-idempotent retry. A reconnect/relaunch uses the same budget.
                if readback.baseline.hash == baseline.hash, attempt.sends < 2 { pending = true }
            }
        } catch ScopedModelsFailure.stale {
            // Superseded revisions/generations cannot mark a newer intent applied.
        } catch {
            guard current(endpoint) else { return }
            let status: ScopedModelsHostStatus
            switch error {
            case ScopedModelsFailure.unsupported: status = .unsupported
            case ScopedModelsFailure.readOnly: status = .readOnly
            case ScopedModelsFailure.nativeActionRequired: status = .authorizationRequired
            case ScopedModelsFailure.settingsUnreadable: status = .settingsUnreadable
            default: status = .failed
            }
            do {
                try await record(endpoint, revision: expectedRevision, decision: expectedDecision) {
                    if $0.status != .divergent { $0.status = status }
                }
            }
            catch ScopedModelsFailure.stale {}
            catch { if current(endpoint) { storageFailed() } }
        }
    }

    private func applied(_ endpoint: Endpoint, attempt: ScopedModelsHostState.Attempt,
                         decision: UUID, baseline: ScopedModelsBaseline) async throws {
        guard current(endpoint) else { throw ScopedModelsFailure.stale }
        let host = endpoint.token.host
        let value = try await store.update { state in
            guard let entry = state.entry(host), entry.decision == decision, entry.participates,
                  entry.attempt?.id == attempt.id else { throw ScopedModelsFailure.stale }
            let latest = state.revision == attempt.revision && state.desired == attempt.selection
            state.edit(host) {
                $0.observed = baseline; $0.baseline = baseline
                $0.appliedRevision = attempt.revision; $0.appliedHash = baseline.hash; $0.attempt = nil
                // An older confirmed application may advance our CAS baseline, never mark
                // the newer saved revision synced. The serialized next pass applies it.
                $0.status = latest ? .synced : .pending
            }
        }
        guard current(endpoint) else { throw ScopedModelsFailure.stale }
        publish(value)
    }
}
