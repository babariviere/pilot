import Foundation
import PilotCore

/// Lifecycle adapter only. Pairing supplies existing per-peer capabilities; home/executor own
/// every durable cursor and operation. Nothing runs at construction or while unpaired.
@MainActor final class ControlCourier {
    struct Registration {
        let enrollment: ControlHomeEnrollment
        let home: HostRef
        let executor: HostRef
        let homeSigning: ControlCourierSigning
        let executorSigning: ControlCourierSigning
    }
    struct Endpoint {
        let token: HostConnectionToken
        let isCurrent: () -> Bool
        let request: (ControlCourierRequest, ControlCourierSigning) async throws -> Data
    }
    private struct Passes {
        let ordinary: ControlCourierPass
        let safety: ControlCourierPass
        let home: HostConnectionToken
        let executor: HostConnectionToken
        let revision = UUID()
    }
    private let ordinary = ControlCourierScheduler()
    private let safety = ControlCourierScheduler(concurrency: 1)
    private var registrations: [HostRef: Registration] = [:]
    private var endpoints: [HostRef: Endpoint] = [:]
    private var passes: [HostRef: Passes] = [:]
    private var requiresReadback: Set<HostRef> = []
    private var started = false
    private var stopped = false
    var failures: Set<HostRef> { ordinary.failures.union(safety.failures) }
    var isIdle: Bool { ordinary.isIdle && safety.isIdle }

    /// Two ordinary + one reserved safety job, each issuing one HTTP request at a time. The
    /// fourth Control slot remains available to native pairing/revocation reconciliation.
    func start() throws { guard !stopped else { return }; started = true; try rebuild() }

    func register(_ value: Registration) throws {
        guard !stopped else { throw HostRoutingError.staleGeneration }
        guard registrations.count < 32 || registrations[value.executor] != nil,
              value.home.hostId == "local", value.enrollment.schemaVersion == 1,
              value.enrollment.generation > 0, value.enrollment.generation <= UInt64(ControlCourierAPI.maximumCounter),
              !value.enrollment.bindingId.isEmpty, value.enrollment.bindingId.utf8.count <= 128,
              value.enrollment.home != value.enrollment.executor, value.enrollment.home.matches(value.home),
              value.enrollment.executor.matches(value.executor), value.home != value.executor,
              registrations.values.allSatisfy({ $0.home == value.home && ($0.executor == value.executor
                  || $0.enrollment.executor != value.enrollment.executor) }) else { throw HostRoutingError.identityChanged }
        for signing in [value.homeSigning, value.executorSigning] {
            let capability = signing.capability
            guard capability.bindingId == value.enrollment.bindingId, capability.generation == value.enrollment.generation,
                  capability.home == value.enrollment.home, capability.executor == value.enrollment.executor,
                  capability.roleFence.home > 0, capability.roleFence.executor > 0 else { throw HostRoutingError.identityChanged }
        }
        guard value.homeSigning.capability.roleFence == value.executorSigning.capability.roleFence,
              value.homeSigning.capability.appKeyId == value.executorSigning.capability.appKeyId else { throw HostRoutingError.identityChanged }
        registrations[value.executor] = value
        requiresReadback.remove(value.executor)
        passes[value.executor] = nil
        try rebuild()
    }

    func update(_ values: [HostRef: Endpoint]) throws {
        guard !stopped else { return }
        guard values.count <= 33, values.allSatisfy({ $0.key == $0.value.token.host }) else { throw HostRoutingError.invalidReference }
        endpoints = values
        try rebuild()
    }

    /// Both sockets feed this existing wire invalidation. Imports at home must not start another
    /// executor capture; otherwise completed status imports would create a feedback polling loop.
    func changed(_ change: ControlHostInvalidation, on source: HostRef) {
        guard started, !stopped else { return }
        for (host, registration) in registrations where registration.enrollment.bindingId == change.bindingId
            && registration.enrollment.generation == change.generation && (source == host || source == registration.home) {
            guard let pass = passes[host] else { continue }
            if source == registration.home {
                if change.changes.contains(.outbox) || change.changes.contains(.receipts) {
                    pass.ordinary.request([.operations]); pass.safety.request([.operations])
                    safety.changed(host); ordinary.changed(host)
                }
                if change.changes.contains(.reads) { pass.ordinary.request([.reads]); ordinary.changed(host) }
            } else {
                var work: [ControlCourierPass.Phase] = []
                if change.changes.contains(.events) { work.append(.events) }
                if change.changes.contains(.status) { work.append(.status) }
                if !work.isEmpty { pass.ordinary.request(work); ordinary.changed(host) }
            }
            // Epoch/enrollment changes require pairing's refreshed readback/capability, not an
            // inferred new grant. Receipts/facts remain durable while that owner reconciles.
            if change.changes.contains(.enrollment) || change.changes.contains(.role) || change.changes.contains(.archive) {
                passes[host] = nil
                requiresReadback.insert(host)
                try? rebuild()
            }
        }
    }

    func remove(_ host: HostRef) throws {
        registrations[host] = nil; passes[host] = nil
        requiresReadback.remove(host)
        try rebuild()
    }

    private func rebuild() throws {
        guard started, !stopped else { return }
        var ordinaryEndpoints: [HostRef: ControlCourierScheduler.Endpoint] = [:]
        var safetyEndpoints: [HostRef: ControlCourierScheduler.Endpoint] = [:]
        for (host, registration) in registrations where !requiresReadback.contains(host) {
            guard let home = endpoints[registration.home], let executor = endpoints[host],
                  home.isCurrent(), executor.isCurrent() else { passes[host] = nil; continue }
            let pass: Passes
            if let existing = passes[host], existing.home == home.token, existing.executor == executor.token { pass = existing }
            else {
                func api(_ endpoint: Endpoint, _ signing: ControlCourierSigning) -> ControlCourierAPI {
                    ControlCourierAPI(token: endpoint.token, isCurrent: endpoint.isCurrent,
                        send: { try await endpoint.request($0, signing) })
                }
                let homeAPI = api(home, registration.homeSigning), executorAPI = api(executor, registration.executorSigning)
                pass = try Passes(ordinary: ControlCourierPass(binding: registration.enrollment, home: homeAPI, target: executorAPI, lane: .ordinary),
                    safety: ControlCourierPass(binding: registration.enrollment, home: homeAPI, target: executorAPI, lane: .revocation),
                    home: home.token, executor: executor.token)
                passes[host] = pass
            }
            let current = { home.isCurrent() && executor.isCurrent() }
            ordinaryEndpoints[host] = ControlCourierScheduler.Endpoint(home: home.token, target: executor.token,
                isCurrent: current, exchange: { try await pass.ordinary.step($0) }, revision: pass.revision)
            safetyEndpoints[host] = ControlCourierScheduler.Endpoint(home: home.token, target: executor.token,
                isCurrent: current, exchange: { try await pass.safety.step($0) }, revision: pass.revision)
        }
        try safety.update(safetyEndpoints)
        try ordinary.update(ordinaryEndpoints)
    }

    func stop() {
        stopped = true; ordinary.stop(); safety.stop()
        endpoints.removeAll(); passes.removeAll(); registrations.removeAll(); requiresReadback.removeAll()
    }
    func stopAndWait() async { stop(); await ordinary.stopAndWait(); await safety.stopAndWait() }
}
