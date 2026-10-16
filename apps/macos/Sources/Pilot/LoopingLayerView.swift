import AppKit
import QuartzCore

/// Base for chat motion that plays on Core Animation: subclasses add looping animations to their layers, which the
/// render server plays with no main-thread work per frame. Loops are removed while the window is occluded, hidden or
/// gone, and start at a phase taken from the wall clock, so separate views (and views recreated by SwiftUI) move in
/// step, as they did on the shared 12 fps clock.
@MainActor
class LoopingLayerView: NSView {
    /// False holds the still frame, for Reduce Motion.
    var animates = true {
        didSet { if animates != oldValue { refreshAnimations() } }
    }
    nonisolated(unsafe) private var occlusionObserver: NSObjectProtocol?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    deinit {
        if let occlusionObserver { NotificationCenter.default.removeObserver(occlusionObserver) }
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let occlusionObserver { NotificationCenter.default.removeObserver(occlusionObserver) }
        occlusionObserver = window.map { window in
            NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window,
                                                   queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshAnimations() }
            }
        }
        refreshAnimations()
    }

    /// Whether loops play now: wanted, and the window is visible on screen.
    var playing: Bool {
        guard animates, let window else { return false }
        return window.occlusionState.contains(.visible)
    }

    /// Removes and, while playing, re-adds the loops. Call after anything they depend on changes.
    func refreshAnimations() {
        removeLoops()
        if playing { addLoops() }
    }

    /// Subclasses add their loops here.
    func addLoops() {}
    /// Subclasses remove their loops here.
    func removeLoops() {}

    /// A begin time placing a loop of `duration` at the same phase in every view.
    static func sharedBeginTime(duration: CFTimeInterval, now: Date = .now) -> CFTimeInterval {
        CACurrentMediaTime() - now.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: duration)
    }

    /// A repeating keyframe animation with evenly spaced values. Discrete loops hold each value for an equal share of
    /// the loop; linear loops interpolate, so pass the first value again at the end.
    static func loop(_ keyPath: String, values: [Any], duration: CFTimeInterval, discrete: Bool = false) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values
        let steps = max(1, discrete ? values.count : values.count - 1)
        animation.keyTimes = (0 ... steps).map { NSNumber(value: Double($0) / Double(steps)) }
        animation.duration = duration
        animation.repeatCount = .infinity
        animation.calculationMode = discrete ? .discrete : .linear
        animation.isRemovedOnCompletion = false
        animation.beginTime = sharedBeginTime(duration: duration)
        return animation
    }
}
