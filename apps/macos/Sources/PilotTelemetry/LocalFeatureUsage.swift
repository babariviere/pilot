import Foundation
import PilotCore

/// Independent local-only aggregate collector. Remote analytics consent and tracers are never consulted.
public final class LocalFeatureUsage: @unchecked Sendable {
    public static let shared = LocalFeatureUsage()
    private let lock = NSLock()
    private let now: @Sendable () -> Date
    private var epoch: String?
    private var producer = UUID().uuidString.lowercased()
    private var startedAt = ""
    private var revision = 0
    private var dropped = 0
    private var cells: [String: FeatureUsageCell] = [:]
    private var dailyCounts: [String: Int] = [:]
    private var seen = Set<String>()
    private var notifyPending = false
    private var listener: (@Sendable () -> Void)?

    public init(now: @escaping @Sendable () -> Date = { Date() }) { self.now = now }

    public func onChange(_ callback: @escaping @Sendable () -> Void) {
        let notify = lock.withLock { listener = callback; return epoch != nil && notifyPending }
        if notify { callback() }
    }

    public func configure(enabled: Bool, epoch: String?) {
        let valid = enabled ? epoch.flatMap(UUID.init(uuidString:))?.uuidString.lowercased() : nil
        let callback = lock.withLock { () -> (@Sendable () -> Void)? in
            guard self.epoch != valid else { return nil }
            self.epoch = valid; producer = UUID().uuidString.lowercased()
            startedAt = timestamp(now()); revision = 0; dropped = 0
            cells.removeAll(); dailyCounts.removeAll(); seen.removeAll()
            notifyPending = valid != nil
            return valid == nil ? nil : listener
        }
        callback?()
    }

    public func record(_ event: FeatureEvent) {
        let callback = lock.withLock { () -> (@Sendable () -> Void)? in
            guard epoch != nil else { return nil }
            let date = now(), day = String(timestamp(date).prefix(10))
            prune(date)
            if event.stage == .eligibility || event.stage == .exposure {
                guard seen.insert("\(event.feature.rawValue):\(event.stage.rawValue)").inserted else { return nil }
            }
            revision += 1
            if dailyCounts[day, default: 0] >= 10_000 { dropped = min(1_000_000, dropped + 1) }
            else {
                dailyCounts[day, default: 0] += 1
                let key = [day, event.feature.rawValue, event.stage.rawValue, event.availability?.rawValue ?? "",
                           event.outcome?.rawValue ?? "", event.reason?.rawValue ?? ""].joined(separator: ":")
                if cells[key] != nil { cells[key]!.count += 1 }
                else { cells[key] = FeatureUsageCell(event: event, day: day) }
            }
            guard !notifyPending else { return nil }
            notifyPending = true
            return listener
        }
        callback?()
    }

    public func snapshot() -> FeatureUsageBatch? {
        lock.withLock {
            guard let epoch else { return nil }
            let date = now(); prune(date); notifyPending = false
            return FeatureUsageBatch(epoch: epoch, producer: producer, revision: revision, startedAt: startedAt,
                observedAt: timestamp(date), cells: cells.keys.sorted().compactMap { cells[$0] }, dropped: dropped)
        }
    }

    public var currentRevision: Int { lock.withLock { revision } }
    private func timestamp(_ date: Date) -> String { date.ISO8601Format() }
    private func prune(_ date: Date) {
        let cutoff = String(timestamp(date.addingTimeInterval(-6 * 86_400)).prefix(10))
        cells = cells.filter { $0.value.day >= cutoff }
        dailyCounts = dailyCounts.filter { $0.key >= cutoff }
    }
}
