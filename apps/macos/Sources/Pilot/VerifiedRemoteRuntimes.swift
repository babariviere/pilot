import Combine
import Foundation
import PilotCore

/// Existing hello evidence for lifecycle consumers (including automatic updates). This is native
/// state, not an update plan or permission to install/restart. Unknown/mismatched versions stay unknown.
struct VerifiedRemoteRuntime: Equatable, Sendable {
    let token: HostConnectionToken
    let hello: DaemonHello
}

@MainActor
final class VerifiedRemoteRuntimes: ObservableObject {
    struct Endpoint {
        let token: HostConnectionToken
        let isCurrent: () -> Bool
        let hello: () async throws -> DaemonHello
    }
    @Published private(set) var observations: [HostRef: VerifiedRemoteRuntime] = [:]
    @Published private(set) var failures: Set<HostRef> = []
    static let concurrency = 2
    private var endpoints: [HostRef: Endpoint] = [:]
    private var attempted: [HostRef: HostConnectionToken] = [:]
    private var pending: [HostRef] = []
    private var running: [HostRef: (UUID, Task<Void, Never>)] = [:]
    private var stopped = false
    var isIdle: Bool { pending.isEmpty && running.isEmpty }

    func update(_ next: [HostRef: Endpoint]) {
        guard !stopped else { return }
        guard next.count <= 32, next.allSatisfy({ $0.key == $0.value.token.host && $0.key.hostId != "local" }) else { stop(); return }
        let old = endpoints
        endpoints = next
        attempted = attempted.filter { next[$0.key] != nil }
        for host in Set(old.keys).union(next.keys) where old[host]?.token != next[host]?.token {
            running[host]?.1.cancel()
            observations[host] = nil
            failures.remove(host)
            pending.removeAll { $0 == host }
            if next[host] != nil { pending.append(host) }
        }
        pump()
    }

    func stop() {
        stopped = true
        endpoints.removeAll(); pending.removeAll(); observations.removeAll(); failures.removeAll()
        for item in running.values { item.1.cancel() }
    }

    private func pump() {
        guard !stopped else { return }
        while running.count < Self.concurrency, let index = pending.firstIndex(where: { running[$0] == nil }) {
            let host = pending.remove(at: index)
            guard let endpoint = endpoints[host], attempted[host] != endpoint.token else { continue }
            attempted[host] = endpoint.token
            let id = UUID()
            let task = Task { [weak self] in
                guard let self else { return }
                do {
                    try Task.checkCancellation()
                    guard endpoint.isCurrent() else { throw HostRoutingError.staleGeneration }
                    let hello = try await endpoint.hello()
                    try Task.checkCancellation()
                    guard !self.stopped, self.endpoints[host]?.token == endpoint.token,
                          endpoint.isCurrent() else { throw HostRoutingError.staleGeneration }
                    try host.validate(hello)
                    guard !hello.daemonVersion.isEmpty else { throw HostRoutingError.incompatible }
                    self.observations[host] = VerifiedRemoteRuntime(token: endpoint.token, hello: hello)
                    self.failures.remove(host)
                } catch {
                    if !self.stopped, self.endpoints[host]?.token == endpoint.token, !(error is CancellationError) {
                        self.failures.insert(host)
                    }
                }
                // Cancellation cannot free a slot until its HTTP read has actually unwound.
                if self.running[host]?.0 == id { self.running[host] = nil }
                self.pump()
            }
            running[host] = (id, task)
        }
    }
}
