import SwiftUI

/// The sign of live work inside a view, such as a running tool step or the chat's working line: three round dots
/// in a row (2.9 pt on a 4.3 pt pitch, centred in a 13×13 pt frame, about the visual size of a row icon, which it
/// often replaces). In turn, left to right, each dot blends from a light grey at rest to Theme.workingInk and lifts
/// slightly, like a typing indicator, then all three rest briefly: about 1.5 s a loop. `background` is fainter and
/// half as fast, for an agent that is idle while its background jobs run (the same motion language as a background
/// working corner).
///
/// It draws on the shared corner clock (`DitherCornerClock`), so only the dots redraw each frame, never the view
/// around it, and its frame is fixed, so neighbouring text never shifts. Reduce Motion holds one still frame. It
/// is decorative: the text beside it carries the state for VoiceOver.
struct EllipsisSpinner: View {
    var background = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                dots(frame: EllipsisDots.stillFrame(background: background))
            } else {
                DitherCornerTicking { frame in dots(frame: frame) }
            }
        }
        .frame(width: EllipsisDots.side, height: EllipsisDots.side)
        .accessibilityHidden(true)
    }

    private func dots(frame: Int) -> some View {
        let levels = EllipsisDots.levels(frame: frame, background: background)
        let rest = Theme.faintForeground.opacity(
            EllipsisDots.restOpacity * (background ? EllipsisDots.backgroundRestOpacity : 1))
        let tint = Theme.workingInk
        return Canvas { context, _ in
            for (index, level) in levels.enumerated() {
                let dot = Path(ellipseIn: EllipsisDots.dotRect(index, level: level))
                context.fill(dot, with: .color(rest))
                if level > 0 { context.fill(dot, with: .color(tint.opacity(level))) }
            }
        }
        .frame(width: EllipsisDots.side, height: EllipsisDots.side)
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
        let progress = Double(loopFrame(frame, background: background)) / loop - Double(index) * stagger
        guard progress > 0, progress < pulse else { return 0 }
        return (background ? backgroundPeak : 1) * sin(Double.pi * progress / pulse)
    }

    /// Levels of the three dots, left to right.
    static func levels(frame: Int, background: Bool) -> [Double] {
        (0 ..< count).map { level($0, frame: frame, background: background) }
    }
}

