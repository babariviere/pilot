import AppKit
import QuartzCore
import SwiftUI

/// The sign of live work inside a view, such as a running tool step or the chat's working line: three round dots
/// in a row (2.9 pt on a 4.3 pt pitch, centred in a 13×13 pt frame, about the visual size of a row icon, which it
/// often replaces). In turn, left to right, each dot blends from a light grey at rest to Theme.workingInk and lifts
/// slightly, like a typing indicator, then all three rest briefly: about 1.5 s a loop. `background` is fainter and
/// half as fast, for an agent that is idle while its background jobs run (the same motion language as a background
/// working corner). `size` scales the whole mark, for icon contexts.
///
/// It plays on Core Animation (`LoopingLayerView`) at the display's rate, with no SwiftUI updates per frame, and
/// its frame is fixed, so neighbouring text never shifts. Spinners share a phase. Reduce Motion holds one still
/// frame; occluded windows play nothing. It is decorative: the text beside it carries the state for VoiceOver.
struct EllipsisSpinner: View {
    var background = false
    var size = EllipsisDots.side
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        EllipsisSpinnerLayer(background: background, still: reduceMotion)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct EllipsisSpinnerLayer: NSViewRepresentable {
    let background: Bool
    let still: Bool

    func makeNSView(context: Context) -> EllipsisSpinnerView {
        let view = EllipsisSpinnerView(frame: NSRect(x: 0, y: 0, width: EllipsisDots.side, height: EllipsisDots.side))
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: EllipsisSpinnerView, context: Context) {
        view.background = background
        view.animates = !still
    }
}

/// Three dot layers inside one content layer scaled to the view. Each dot is the resting grey with an ink layer
/// on top whose opacity is the dot's level; the dot itself lifts by `EllipsisDots.lift` times that level.
final class EllipsisSpinnerView: LoopingLayerView {
    var background = false {
        didSet {
            guard background != oldValue else { return }
            updateColors()
            showStillFrame()
            refreshAnimations()
        }
    }
    private let content = CALayer()
    private var dots: [(dot: CALayer, ink: CALayer)] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        content.anchorPoint = .zero
        content.bounds = CGRect(x: 0, y: 0, width: EllipsisDots.side, height: EllipsisDots.side)
        for index in 0 ..< EllipsisDots.count {
            let dot = CALayer()
            let rect = EllipsisDots.dotRect(index)
            // Layers are y-up: the resting rect is vertically centred, so only the lift's sign differs.
            dot.frame = CGRect(x: rect.minX, y: EllipsisDots.side - rect.maxY, width: rect.width, height: rect.height)
            dot.cornerRadius = EllipsisDots.dot / 2
            dot.masksToBounds = true
            let ink = CALayer()
            ink.frame = dot.bounds
            dot.addSublayer(ink)
            content.addSublayer(dot)
            dots.append((dot, ink))
        }
        layer?.addSublayer(content)
        updateColors()
        showStillFrame()
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let scale = bounds.width / EllipsisDots.side
        content.position = .zero
        content.transform = CATransform3DMakeScale(scale, scale, 1)
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    private func updateColors() {
        var rest = NSColor.gray.cgColor, ink = NSColor.systemIndigo.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let opacity = EllipsisDots.restOpacity * (background ? EllipsisDots.backgroundRestOpacity : 1)
            rest = NSColor(Theme.faintForeground).withAlphaComponent(opacity).cgColor
            ink = NSColor(Theme.workingInk).cgColor
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (dot, inkLayer) in dots {
            dot.backgroundColor = rest
            inkLayer.backgroundColor = ink
        }
        CATransaction.commit()
    }

    /// The frame Reduce Motion holds, also the model values under the loops.
    private func showStillFrame() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, (dot, ink)) in dots.enumerated() {
            let level = EllipsisDots.level(index, frame: EllipsisDots.stillFrame(background: background), background: background)
            ink.opacity = Float(level)
            dot.transform = CATransform3DMakeTranslation(0, EllipsisDots.lift * CGFloat(level), 0)
        }
        CATransaction.commit()
    }

    override func addLoops() {
        let duration = EllipsisDots.loopDuration(background: background)
        for (index, (dot, ink)) in dots.enumerated() {
            let levels = EllipsisDots.keyframeLevels(index, background: background)
            ink.add(Self.loop("opacity", values: levels.map { NSNumber(value: $0) }, duration: duration), forKey: "pulse")
            dot.add(Self.loop("transform.translation.y", values: levels.map { NSNumber(value: Double(EllipsisDots.lift) * $0) },
                              duration: duration), forKey: "lift")
        }
    }

    override func removeLoops() {
        for (dot, ink) in dots {
            ink.removeAnimation(forKey: "pulse")
            dot.removeAnimation(forKey: "lift")
        }
    }
}

/// Geometry and timing of `EllipsisSpinner`, kept apart from the view so it is testable.
enum EllipsisDots {
    static let count = 3
    static let dot: CGFloat = 2.9
    static let pitch: CGFloat = 4.3
    static let side: CGFloat = 13
    /// How far a dot rises at full level.
    static let lift: CGFloat = 1.4
    /// One loop at the shared clock's 12 fps: 1.5 s. Both loops divide the clock's count, so they never jump.
    static let frameCount = 18
    /// Half speed while only background jobs run.
    static let backgroundFrameCount = 36
    /// Each dot's pulse lasts a third of the loop and starts a sixth after the previous dot's, so the three overlap
    /// in a ripple and the last third of the loop rests.
    static let pulse = 1.0 / 3
    static let stagger = 1.0 / 6
    /// Opacity of Theme.faintForeground for the resting dots. Light enough that the indigo dot stands apart in
    /// lightness as well as hue, so it reads at a glance; still visible on white and row fills.
    static let restOpacity = 0.5
    /// Peak blend toward Theme.workingInk while only background jobs run.
    static let backgroundPeak = 0.5
    /// Further opacity of the resting dots while only background jobs run.
    static let backgroundRestOpacity = 0.6

    /// Dot `index` (0 = left), centred in the frame, raised by `lift` times its level.
    static func dotRect(_ index: Int, level: Double = 0) -> CGRect {
        let inset = (side - pitch * CGFloat(count - 1) - dot) / 2
        return CGRect(x: inset + CGFloat(index) * pitch, y: (side - dot) / 2 - lift * CGFloat(level),
                      width: dot, height: dot)
    }

    static func loopFrame(_ frame: Int, background: Bool) -> Int {
        let loop = background ? backgroundFrameCount : frameCount
        return ((frame % loop) + loop) % loop
    }

    /// The frame Reduce Motion holds: the middle dot at its peak, its neighbours at rest.
    static func stillFrame(background: Bool) -> Int {
        (background ? backgroundFrameCount : frameCount) / 3
    }

    /// Blend in 0...1 toward Theme.workingInk of dot `index`: a half sine over its pulse, zero otherwise.
    static func level(_ index: Int, frame: Int, background: Bool) -> Double {
        let loop = Double(background ? backgroundFrameCount : frameCount)
        return level(index, progress: Double(loopFrame(frame, background: background)) / loop, background: background)
    }

    /// The same pulse at any point of the loop (0 ..< 1), so Core Animation can interpolate it at the display rate.
    static func level(_ index: Int, progress: Double, background: Bool) -> Double {
        let local = progress - Double(index) * stagger
        guard local > 0, local < pulse else { return 0 }
        return (background ? backgroundPeak : 1) * sin(Double.pi * local / pulse)
    }

    /// One loop's length: `frameCount` steps of the former 12 fps clock (1.5 s), twice that in the background.
    static func loopDuration(background: Bool) -> Double {
        Double(background ? backgroundFrameCount : frameCount) / 12
    }

    /// Evenly spaced levels of dot `index` over one loop, ending where they start, for linear keyframes. Six
    /// samples per former frame keep the half-sine round at 120 Hz.
    static func keyframeLevels(_ index: Int, background: Bool) -> [Double] {
        let samples = (background ? backgroundFrameCount : frameCount) * 6
        return (0 ... samples).map { level(index, progress: Double($0 % samples) / Double(samples), background: background) }
    }

    /// Levels of the three dots, left to right.
    static func levels(frame: Int, background: Bool) -> [Double] {
        (0 ..< count).map { level($0, frame: frame, background: background) }
    }
}
