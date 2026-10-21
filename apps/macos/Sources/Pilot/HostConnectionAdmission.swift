import Foundation

@MainActor
final class HostConnectionAdmission {
    private var active = 0
    private var order: [UUID] = []
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    func acquire() async throws {
        try Task.checkCancellation()
        if active < 2 { active += 1; return }
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
