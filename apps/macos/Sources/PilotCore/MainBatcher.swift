import Foundation

/// Hands items produced on background queues to the main thread in order, in batches. Everything appended
/// before a scheduled delivery runs is delivered together, so a burst costs one main-thread turn rather than
/// one turn per item. Delivery and `after` callbacks share the main queue, so they stay in append order.
public final class MainBatcher<Item>: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [Item] = []
    private var scheduled = false
    private let deliver: @MainActor ([Item]) -> Void

    public init(deliver: @escaping @MainActor ([Item]) -> Void) {
        self.deliver = deliver
    }

    /// Thread-safe.
    public func append(_ item: Item) {
        let schedule = lock.withLock {
            pending.append(item)
            defer { scheduled = true }
            return !scheduled
        }
        guard schedule else { return }
        DispatchQueue.main.async { MainActor.assumeIsolated { self.flush() } }
    }

    /// Runs `body` on the main thread after every item appended so far has been delivered. Thread-safe.
    public func after(_ body: @escaping @MainActor () -> Void) {
        DispatchQueue.main.async { MainActor.assumeIsolated { body() } }
    }

    @MainActor private func flush() {
        let items = lock.withLock {
            defer {
                pending = []
                scheduled = false
            }
            return pending
        }
        if !items.isEmpty { deliver(items) }
    }
}
