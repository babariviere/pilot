import AppKit
import PilotCore
import QuartzCore
import SwiftUI

// MARK: - Running tool title shimmer

extension ToolStatus {
    /// Running or about to run, in the turn that is still working.
    func isLive(active: Bool) -> Bool { active && (self == .running || self == .pending) }
}

extension View {
    /// A light band that sweeps across a running step's title. The title draws in `Theme.foreground`; a veil of the
    /// background colour dims it to `Theme.mutedForeground` everywhere except the moving band. Core Animation plays
    /// the sweep; it changes only colour, never layout. Callers drop it when the step finishes, and under Reduce
    /// Motion (then the title keeps its muted colour without a veil).
    func runningShimmer() -> some View {
        overlay(ShimmerOverlay().allowsHitTesting(false).accessibilityHidden(true))
    }
}

private struct ShimmerOverlay: NSViewRepresentable {
    func makeNSView(context: Context) -> ShimmerView { ShimmerView(frame: .zero) }
    func updateNSView(_ view: ShimmerView, context: Context) {}
}

final class ShimmerView: LoopingLayerView {
    private let gradient = CAGradientLayer()
    private var sweptWidth: CGFloat = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        layer?.masksToBounds = true
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
        // The band is the middle of a gradient three times the title's width, so the veil stays even around it.
        gradient.locations = [0, 0.4, 0.5, 0.6, 1]
        layer?.addSublayer(gradient)
        updateColors()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    private func updateColors() {
        var veil = NSColor.white.cgColor, clear = NSColor.clear.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let background = NSColor(Theme.background)
            veil = background.withAlphaComponent(Theme.Motion.shimmerVeil).cgColor
            clear = background.withAlphaComponent(0).cgColor
        }
        gradient.colors = [veil, veil, clear, veil, veil]
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // At rest the band waits just left of the title; the loop moves it past the right edge.
        gradient.frame = CGRect(x: -1.5 * bounds.width - Self.band(bounds.width), y: 0,
                                width: 3 * bounds.width, height: bounds.height)
        CATransaction.commit()
        if bounds.width != sweptWidth {
            sweptWidth = bounds.width
            refreshAnimations()
        }
    }

    private static func band(_ width: CGFloat) -> CGFloat { 0.3 * width }

    override func addLoops() {
        guard bounds.width > 0 else { return }
        let distance = bounds.width + 2 * Self.band(bounds.width)
        let animation = CAKeyframeAnimation(keyPath: "transform.translation.x")
        // Sweep for two thirds of the loop, then rest.
        animation.values = [0, distance, distance]
        animation.keyTimes = [0, 0.67, 1]
        animation.timingFunctions = [CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .linear)]
        animation.duration = Theme.Motion.shimmerLoop
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        animation.beginTime = Self.sharedBeginTime(duration: Theme.Motion.shimmerLoop)
        gradient.add(animation, forKey: "sweep")
    }

    override func removeLoops() {
        gradient.removeAnimation(forKey: "sweep")
    }
}

// MARK: - Expand reveal

extension View {
    /// Reveals content that a disclosure just opened: a cover of the background colour shrinks toward the bottom
    /// edge while it fades, on Core Animation. The content takes its full height at once, so the transcript lays out
    /// once instead of on every frame of a height animation. Content shown for any other reason (opening a chat,
    /// scrolling a row back into view) appears at once, as it does under Reduce Motion.
    func revealsWhenOpened(_ expansion: ExpansionState) -> some View {
        modifier(RevealWhenOpened(expansion: expansion))
    }
}

private struct RevealWhenOpened: ViewModifier {
    let expansion: ExpansionState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.overlay {
            if !reduceMotion, expansion.justOpened() {
                RevealCover().allowsHitTesting(false).accessibilityHidden(true)
            }
        }
    }
}

private struct RevealCover: NSViewRepresentable {
    func makeNSView(context: Context) -> RevealCoverView { RevealCoverView(frame: .zero) }
    func updateNSView(_ view: RevealCoverView, context: Context) {}
}

final class RevealCoverView: NSView {
    private let cover = CALayer()
    private(set) var played = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        // Layers are y-up: anchored at the bottom edge, shrinking uncovers the content from the top down.
        cover.anchorPoint = CGPoint(x: 0.5, y: 0)
        layer?.addSublayer(cover)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cover.frame = bounds
        CATransaction.commit()
        if !played, window != nil, bounds.height > 0 { play() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        needsLayout = true
    }

    private func play() {
        played = true
        var color = NSColor.white.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { color = NSColor(Theme.background).cgColor }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cover.backgroundColor = color
        CATransaction.commit()
        let shrink = CABasicAnimation(keyPath: "transform.scale.y")
        shrink.fromValue = 1
        shrink.toValue = 0
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [shrink, fade]
        group.duration = Theme.Motion.expandReveal
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        cover.opacity = 0
        cover.add(group, forKey: "reveal")
    }
}
