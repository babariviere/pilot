import Foundation

/// Native renderer callbacks may run off-actor. Bound retained input before scheduling UI work.
final class TerminalCallbacks: @unchecked Sendable {
    private let lock = NSLock()
    private var inputs: [Data] = []
    private var bytes = 0
    private var viewport: (Int, Int)?
    private var outputPaused: Bool?
    private var rejected = false
    private var scheduled = false
    private var closed = false
    private var inputEnabled = true
    private let deliver: @MainActor ([Data], (Int, Int)?, Bool, Bool?) -> Void
    init(deliver: @escaping @MainActor ([Data], (Int, Int)?, Bool, Bool?) -> Void) { self.deliver = deliver }

    func write(_ data: Data) {
        enqueue {
            guard inputEnabled else { return }
            if rejected || data.count > 16 * 1024 || inputs.count >= 64 || bytes + data.count > 256 * 1024 { rejected = true }
            else { inputs.append(data); bytes += data.count }
        }
    }
    func resize(cols: Int, rows: Int) { enqueue { viewport = (cols, rows) } }
    func backlog(_ paused: Bool) { enqueue { outputPaused = paused } }
    func setInputEnabled(_ enabled: Bool) {
        lock.withLock {
            inputEnabled = enabled
            if !enabled { inputs = []; bytes = 0; rejected = false }
        }
    }
    private func enqueue(_ action: () -> Void) {
        let schedule = lock.withLock {
            guard !closed else { return false }
            action()
            defer { scheduled = true }
            return !scheduled
        }
        if schedule { DispatchQueue.main.async { MainActor.assumeIsolated { self.flush() } } }
    }
    @MainActor private func flush() {
        let batch = lock.withLock { () -> ([Data], (Int, Int)?, Bool, Bool?)? in
            defer { inputs = []; bytes = 0; viewport = nil; outputPaused = nil; rejected = false; scheduled = false }
            return closed ? nil : (inputs, viewport, rejected, outputPaused)
        }
        if let batch { deliver(batch.0, batch.1, batch.2, batch.3) }
    }
    func close() { lock.withLock { closed = true; inputs = []; bytes = 0; viewport = nil } }
}
