import Foundation

/// A serial executor on its own thread. QuickJS checks its stack limit against the calling thread's stack, so each
/// engine runs on a thread with a known, generous stack instead of a dispatch worker's 512 KiB.
final class VisualExecutor: @unchecked Sendable {
    private let condition = NSCondition()
    private var jobs: [() -> Void] = []
    private var finished = false

    init(name: String, stackSize: Int) {
        let thread = Thread { [self] in run() }
        thread.name = name
        thread.stackSize = stackSize
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    /// Queues a job. Jobs submitted after finish are dropped, so callers submit under their own lock.
    func submit(_ job: @escaping () -> Void) {
        condition.lock()
        defer { condition.unlock() }
        guard !finished else { return }
        jobs.append(job)
        condition.signal()
    }

    /// Runs last after every queued job, then ends the thread.
    func finish(_ last: @escaping () -> Void) {
        condition.lock()
        defer { condition.unlock() }
        guard !finished else { return }
        jobs.append(last)
        finished = true
        condition.signal()
    }

    private func run() {
        while true {
            condition.lock()
            while jobs.isEmpty && !finished { condition.wait() }
            if jobs.isEmpty {
                condition.unlock()
                return
            }
            let job = jobs.removeFirst()
            condition.unlock()
            autoreleasepool { job() }
        }
    }
}

