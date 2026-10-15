import SwiftUI

/// The sign of live work inside a view, such as a running tool step or the chat's working line: a fixed 4×4 grid
/// of round dots (2.2 pt on a 3.3 pt pitch, 13×13 pt, about the visual size of a row icon, which it often replaces).
/// The dots never move. Each blends from a light grey at rest to
/// Theme.workingInk as a wave runs diagonally from the top-left corner to the bottom-right, about 1.5 s a
/// loop. `background` is fainter and half as fast, for an agent that is idle while its background jobs run (the
/// same motion language as a background working corner).
///
/// It draws on the shared corner clock (`DitherCornerClock`), so only the grid redraws each frame, never the view
/// around it, and its frame is fixed, so neighbouring text never shifts. Reduce Motion holds one still frame. It
/// is decorative: the text beside it carries the state for VoiceOver.
struct DotGridSpinner: View {
    var background = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                grid(frame: DotGrid.stillFrame(background: background))
            } else {
                DitherCornerTicking { frame in grid(frame: frame) }
            }
        }
        .frame(width: DotGrid.side, height: DotGrid.side)
        .accessibilityHidden(true)
    }

    private func grid(frame: Int) -> some View {
        let levels = DotGrid.levels(frame: frame, background: background)
        let rest = Theme.faintForeground.opacity(DotGrid.restOpacity * (background ? DotGrid.backgroundRestOpacity : 1))
        let tint = Theme.workingInk
        return Canvas { context, _ in
            for (index, rect) in DotGrid.dotRects.enumerated() {
                let dot = Path(ellipseIn: rect)
                context.fill(dot, with: .color(rest))
                if levels[index] > 0 { context.fill(dot, with: .color(tint.opacity(levels[index]))) }
            }
        }
        .frame(width: DotGrid.side, height: DotGrid.side)
    }
}

/// Geometry and timing of `DotGridSpinner`, kept apart from the view so it is testable.
enum DotGrid {
    static let columns = 4
    static let dot: CGFloat = 2.2
    static let pitch: CGFloat = 3.3
    static let side: CGFloat = 13
    /// One loop at the shared clock's 12 fps: 1.5 s. Both loops divide the clock's count, so they never jump.
    static let frameCount = 18
    /// Half speed while only background jobs run.
    static let backgroundFrameCount = 36
    /// Width of the wave's crest along the diagonal, as a fraction of it.
    static let crest = 0.35
    /// Opacity of Theme.faintForeground for the resting dots. Light enough that the indigo crest stands apart in
    /// lightness as well as hue, so the wave reads at a glance; still visible on white and row fills.
    static let restOpacity = 0.5
    /// Peak blend toward Theme.workingInk while only background jobs run.
    static let backgroundPeak = 0.5
    /// Further opacity of the resting dots while only background jobs run.
    static let backgroundRestOpacity = 0.6

    /// The 16 dots, row by row, centred in the 13×13 frame.
    static let dotRects: [CGRect] = {
        let inset = (side - pitch * CGFloat(columns - 1) - dot) / 2
        return (0 ..< columns * columns).map { index in
            CGRect(x: inset + CGFloat(index % columns) * pitch, y: inset + CGFloat(index / columns) * pitch,
                   width: dot, height: dot)
        }
    }()

    static func loopFrame(_ frame: Int, background: Bool) -> Int {
        let loop = background ? backgroundFrameCount : frameCount
        return ((frame % loop) + loop) % loop
    }

    /// The frame Reduce Motion holds: the crest across the middle of the diagonal.
    static func stillFrame(background: Bool) -> Int {
        (background ? backgroundFrameCount : frameCount) / 2
    }

    /// Blend in 0...1 toward Theme.workingInk of the dot at column `x`, row `y`. The phase comes from `x + y`, so the
    /// wave runs diagonally; the crest starts before the first corner and ends past the last, so a loop has a brief
    /// rest and wraps without a jump.
    static func level(x: Int, y: Int, frame: Int, background: Bool) -> Double {
        let loop = Double(background ? backgroundFrameCount : frameCount)
        let progress = Double(loopFrame(frame, background: background)) / loop
        let position = Double(x + y) / Double(2 * (columns - 1))
        let center = progress * (1 + 2 * crest) - crest
        let distance = abs(position - center) / crest
        guard distance < 1 else { return 0 }
        let near = 1 - distance
        return (background ? backgroundPeak : 1) * near * near * (3 - 2 * near)
    }

    /// Levels of all 16 dots, row by row, matching `dotRects`.
    static func levels(frame: Int, background: Bool) -> [Double] {
        (0 ..< columns * columns).map { level(x: $0 % columns, y: $0 / columns, frame: frame, background: background) }
    }
}
