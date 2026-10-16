import AppKit
import QuartzCore

/// Runs an action at most once per display frame. The first request after a quiet frame runs at once; requests
/// within the same frame are merged and run on the next display-link callback, so a burst of streamed updates
/// publishes once per frame instead of once per batch. The display link is paused whenever nothing is waiting,
/// and a short timer stands in when no display link fires (no screen, occluded windows, tests).
@MainActor
final class DisplayFramePacer {
    private let action: @MainActor () -> Void
    private var lastRun: CFTimeInterval = -.infinity
    private var waiting = false
    // Released from deinit, which is not isolated; both are only otherwise touched on the main actor.
    nonisolated(unsafe) private var link: CADisplayLink?
    nonisolated(unsafe) private var fallback: DispatchWorkItem?
    private lazy var target = Target(self)

    init(_ action: @escaping @MainActor () -> Void) {
        self.action = action
    }

    deinit {
        fallback?.cancel()
        link?.invalidate()
    }

    private var frameInterval: CFTimeInterval {
        1 / Double(max(30, NSScreen.main?.maximumFramesPerSecond ?? 60))
    }

    func request() {
        guard !waiting else { return }
        let interval = frameInterval
        let elapsed = CACurrentMediaTime() - lastRun
        guard elapsed < interval else { return run() }
        waiting = true
        if link == nil, let screen = NSScreen.main {
            let link = screen.displayLink(target: target, selector: #selector(Target.tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
        link?.isPaused = false
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.fire() } }
        fallback = work
        DispatchQueue.main.asyncAfter(deadline: .now() + interval * 2, execute: work)
    }

    /// Drops a waiting request, for example when the feed stops.
    func cancel() {
        waiting = false
        link?.isPaused = true
        fallback?.cancel()
        fallback = nil
    }

    fileprivate func fire() {
        guard waiting else { return }
        cancel()
        run()
    }

    private func run() {
        lastRun = CACurrentMediaTime()
        action()
    }

    /// The display link retains its target; this one holds the pacer weakly.
    private final class Target: NSObject {
        weak var pacer: DisplayFramePacer?
        init(_ pacer: DisplayFramePacer) { self.pacer = pacer }
        @objc func tick(_ link: CADisplayLink) {
            MainActor.assumeIsolated { pacer?.fire() }
        }
    }
}
