import AppKit
import QuartzCore
import SwiftUI

/// A stationary label with a soft left-to-right highlight, followed by a short pause.
struct WorkingIndicator: View {
    let retry: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var visibility = WorkingHighlightVisibility()

    var label: String { retry.map { "Retrying: \($0)" } ?? "Working…" }
    private static let muted = Color(hex: 0x989898)
    static let cycleDuration: TimeInterval = 2.2

    /// Use a shared clock so transcript updates don't restart the wave.
    static func highlightProgress(at time: TimeInterval) -> Double {
        let phase = time.truncatingRemainder(dividingBy: cycleDuration)
        return min(phase / (cycleDuration * 0.8), 1)
    }

    var body: some View {
        Text(label)
            .foregroundStyle(reduceMotion ? Self.muted : .clear)
            .overlay {
                if !reduceMotion {
                    WorkingHighlight(visible: visibility.visible)
                        .mask(Text(label).foregroundStyle(.white).frame(maxWidth: .infinity, alignment: .leading))
                        .accessibilityHidden(true)
                }
            }
            .font(.callout)
            .lineLimit(1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .onAppear { visibility.visible = true }
            .onDisappear { visibility.visible = false }
    }
}

/// The text mask stays in SwiftUI, preserving its exact font and layout. Only the gradient
/// moves, on the compositor, without a TimelineView rebuilding/layouting the transcript.
private struct WorkingHighlight: NSViewRepresentable {
    let visible: Bool
    func makeNSView(context: Context) -> WorkingHighlightView { WorkingHighlightView() }
    func updateNSView(_ view: WorkingHighlightView, context: Context) { view.setVisible(visible) }
    static func dismantleNSView(_ view: WorkingHighlightView, coordinator: ()) { view.dispose() }
}

@MainActor
private final class WorkingHighlightVisibility: ObservableObject {
    @Published var visible = false
}

final class WorkingHighlightView: NSView {
    private let gradient = CAGradientLayer()
    private var animationWidth: CGFloat?
    private var disposed = false
    private var hostVisible = false
    static let animationKey = "working-wave"

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = true
        layer?.addSublayer(gradient)
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
        gradient.anchorPoint = .zero
        gradient.colors = [0x989898, 0x989898, 0x555555, 0x262626, 0x555555, 0x989898, 0x989898].map {
            NSColor(Color(hex: UInt32($0))).cgColor
        }
        gradient.locations = [0, 0.40, 0.46, 0.50, 0.54, 0.60, 1]
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // frame is undefined with a nonidentity transform. Set model geometry directly so
        // subsequent parent layouts cannot shift the wave's bounds/position.
        gradient.bounds = CGRect(x: 0, y: 0, width: bounds.width * 3, height: bounds.height)
        gradient.position = .zero
        gradient.transform = CATransform3DMakeTranslation(-2 * bounds.width, 0, 0)
        CATransaction.commit()
        updateAnimation()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self)
        if let window, !disposed {
            NotificationCenter.default.addObserver(self, selector: #selector(visibilityChanged),
                name: NSWindow.didChangeOcclusionStateNotification, object: window)
        }
        updateAnimation()
    }

    override func viewDidHide() { super.viewDidHide(); updateAnimation() }
    override func viewDidUnhide() { super.viewDidUnhide(); updateAnimation() }
    @objc private func visibilityChanged(_ notification: Notification) { updateAnimation() }

    private func updateAnimation() {
        guard !disposed, hostVisible, window?.occlusionState.contains(.visible) == true,
              !isHiddenOrHasHiddenAncestor, bounds.width > 0, bounds.height > 0 else {
            gradient.removeAnimation(forKey: Self.animationKey)
            animationWidth = nil
            return
        }
        guard animationWidth != bounds.width else { return }
        let animation = Self.waveAnimation(width: bounds.width)
        // Match the shared reference-date clock used by the original SwiftUI wave.
        let phase = Date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: WorkingIndicator.cycleDuration)
        animation.beginTime = gradient.convertTime(CACurrentMediaTime(), from: nil) - phase
        gradient.add(animation, forKey: Self.animationKey)
        animationWidth = bounds.width
    }

    func setVisible(_ visible: Bool) {
        guard visible != hostVisible else { return }
        hostVisible = visible
        updateAnimation()
    }

    static func waveAnimation(width: CGFloat) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: "transform.translation.x")
        animation.values = [-2 * width, 0, 0]
        animation.keyTimes = [0, 0.8, 1]
        animation.duration = WorkingIndicator.cycleDuration
        animation.repeatCount = .infinity
        animation.calculationMode = .linear
        return animation
    }

    func dispose() {
        disposed = true
        NotificationCenter.default.removeObserver(self)
        gradient.removeAnimation(forKey: Self.animationKey)
        animationWidth = nil
    }
}
