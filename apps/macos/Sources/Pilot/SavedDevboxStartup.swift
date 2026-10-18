import Foundation
import PilotCore

/// Explicit live-launch work only. Metadata restoration and construction never start this queue.
@MainActor
final class SavedDevboxStartup {
    struct Request {
        let host: HostRef
        let configuration: SSHConnectionConfiguration
    }
    static let concurrency = 2
    private var started = false
    private var stopped = false
    private var suppressed: Set<String> = []
    private var pending: [Request] = []
    private var running: [HostRef: (UUID, Task<Void, Never>)] = [:]
    private var connect: ((Request) async throws -> Void)?
    var isIdle: Bool { pending.isEmpty && running.isEmpty }

    func start(_ requests: [Request], connect: @escaping (Request) async throws -> Void) {
        guard !started, !stopped else { return }
        started = true
        self.connect = connect
        // The persisted inventory is already bounded. Refuse an invalid/ambiguous inventory wholesale.
        guard requests.count <= 32, Set(requests.map { $0.host.hostId }).count == requests.count,
              requests.allSatisfy({ !$0.host.hostId.isEmpty && $0.host.hostId != "local"
                  && !$0.host.daemonId.isEmpty && !$0.host.lineageId.isEmpty }) else { return }
        pending = requests.filter { !suppressed.contains($0.host.hostId) }.sorted { $0.host.hostId < $1.host.hostId }
        pump()
    }

    /// User intent wins even before start, while queued, or during a suspended connection. An
    /// explicit later manual Reconnect remains possible; it is never an automatic launch retry.
    func suppress(_ host: HostRef) {
        suppressed.insert(host.hostId)
        pending.removeAll { $0.host.hostId == host.hostId }
        for (key, item) in running where key.hostId == host.hostId { item.1.cancel() }
    }

    func stop() {
        stopped = true
        pending.removeAll()
        connect = nil
        for item in running.values { item.1.cancel() }
    }

    private func pump() {
        guard !stopped, let connect else { return }
        while running.count < Self.concurrency, !pending.isEmpty {
            let request = pending.removeFirst()
            guard !suppressed.contains(request.host.hostId) else { continue }
            let id = UUID()
            let task = Task { [weak self] in
                guard let self else { return }
                if !Task.isCancelled, !self.stopped, !self.suppressed.contains(request.host.hostId) {
                    // Transport owns its finite SSH retry budget. A failed launch attempt is not rescheduled.
                    try? await connect(request)
                }
                if self.running[request.host]?.0 == id { self.running[request.host] = nil }
                self.pump()
            }
            running[request.host] = (id, task)
        }
    }
}

/// The same admission bound also covers a manual click racing queued launch work. Cancellation
/// removes a waiter, while a granted slot remains occupied until its owned connection unwinds.
@MainActor
final class HostConnectionAdmission {
    private var active = 0
    private var order: [UUID] = []
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    func acquire() async throws {
        try Task.checkCancellation()
        if active < SavedDevboxStartup.concurrency { active += 1; return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                order.append(id); waiters[id] = continuation
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.order.removeAll { $0 == id }
                self?.waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
            }
        }
    }

    func release() {
        while !order.isEmpty {
            let id = order.removeFirst()
            if let waiter = waiters.removeValue(forKey: id) { waiter.resume(); return }
        }
        active -= 1
    }
}
