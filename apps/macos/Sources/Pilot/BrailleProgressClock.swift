import AppKit
import Combine
import Foundation

/// One publication per glyph tick, rather than one independently scheduled timeline per row.
@MainActor
final class BrailleProgressClock: ObservableObject {
    static let shared = BrailleProgressClock()
    @Published private(set) var frameIndex = BrailleProgress.frameIndex(at: .now)
    private var subscribers: Set<UUID> = []
    private var timer: Timer?
    var subscriberCount: Int { subscribers.count }
    var isRunning: Bool { timer?.isValid == true }

    func subscribe(_ id: UUID) {
        guard subscribers.insert(id).inserted, timer == nil else { return }
        refresh(at: .now)
        let timer = Timer(timeInterval: BrailleProgress.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard NSApp?.isHidden != true,
                      NSApp?.windows.contains(where: { $0.isVisible }) == true else { return }
                self?.refresh(at: .now)
            }
        }
        timer.tolerance = 0.01
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func unsubscribe(_ id: UUID) {
        subscribers.remove(id)
        guard subscribers.isEmpty else { return }
        timer?.invalidate()
        timer = nil
    }

    func refresh(at date: Date) {
        let next = BrailleProgress.frameIndex(at: date)
        if next != frameIndex { frameIndex = next }
    }

    deinit { timer?.invalidate() }
}
