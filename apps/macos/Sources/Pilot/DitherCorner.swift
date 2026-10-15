import AppKit
import PilotCore
import SwiftUI

// MARK: - Dithered status corner

/// A row's `SessionSignal`, drawn as an ordered (Bayer) dither that grows from the row's bottom-right corner,
/// in the same pixel language as `DitherSky`. Each state has its own tint, density and motion, so color is
/// never the only signal: working ripples outward, needs you breathes, failed is steady and dense, ready to
/// merge is steady and light. Quiet rows draw nothing. Changes between states dissolve cell by cell.
///
/// Use `.ditherCorner(_:)` on a row's content. While the pointer is over the row, the corner recedes toward the
/// trailing edge (fewer cells, same pixels) and the row's revealed buttons use the space it frees. Rows wearing a
/// corner draw no hover fill (`HoverRow` reads `rowHasDitherCorner`) and nothing cuts holes in the corner:
/// selection stays the only row fill. Reduce Motion keeps the corner still and recedes it without animating.
/// Larger surfaces that carry one state, such as the agent question tray, pass their own outset and corner
/// radius so the dither stays inside their shape, an `extent` above 1 to grow the corner with the surface, and
/// `recedes: false` when they are not rows. Extent adds cells rather than enlarging them, so the pixels stay the
/// sidebar's size.
/// A working chat whose agent is idle while only its background jobs run passes `background: true`: the ripple
/// is fainter and half as fast, so it still reads as working, in the background.
/// The command palette passes `monochrome: true`: only states that need the user keep their colour, and working or
/// ready-to-merge corners turn grey, so the palette's one colour is the amber of Needs you.
extension View {
    /// The defaults fit sidebar rows: they reach the edges of the native selection highlight.
    func ditherCorner(_ signal: SessionSignal?, background: Bool = false,
                      outset: EdgeInsets = EdgeInsets(top: -3, leading: 0, bottom: -3, trailing: -6),
                      cornerRadius: CGFloat = Theme.Radius.row, extent: Double = 1, recedes: Bool = true,
                      monochrome: Bool = false) -> some View {
        modifier(DitherCornerModifier(signal: signal, background: background && signal == .working, outset: outset,
                                      cornerRadius: cornerRadius, extent: extent, recedes: recedes,
                                      monochrome: monochrome))
    }
}

extension EnvironmentValues {
    /// True inside a view wearing `ditherCorner`. Such rows draw no hover fill: the receding corner is their hover.
    var rowHasDitherCorner: Bool {
        get { self[RowHasDitherCornerKey.self] }
        set { self[RowHasDitherCornerKey.self] = newValue }
    }
}

private struct RowHasDitherCornerKey: EnvironmentKey {
    static let defaultValue = false
}

enum DitherCorner {
    /// Points per cell. Each cell is one image pixel, scaled up with hard edges.
    static let cell: CGFloat = 2
    static let columns = 52
    /// Taller than a two-line row. The corner is bottom-aligned and clipped by the row.
    static let rows = 24
    static var size: CGSize { CGSize(width: CGFloat(columns) * cell, height: CGFloat(rows) * cell) }

    /// Cells across and down for a corner grown by `extent`.
    static func grid(extent: Double) -> (columns: Int, rows: Int) {
        (Int((Double(columns) * extent).rounded()), Int((Double(rows) * extent).rounded()))
    }
    /// One loop of the working ripple and the needs-you breath.
    static let frameCount = 36
    /// One loop of the background ripple, half as fast. The shared clock counts this far.
    static let backgroundFrameCount = 72
    static let frameInterval: TimeInterval = 1.0 / 12
    /// The corner's reach across and up when fully receded, as a fraction of its resting reach. Across, it draws
    /// in to about 40 pt from the trailing edge; up, it leaves a row's first line, where revealed buttons sit.
    static let recededReach = (x: 0.45, y: 0.55)
    /// Quiet: about as long as a row's other hover changes.
    static var recedeAnimation: Animation { .easeOut(duration: 0.3) }

    static func animates(_ signal: SessionSignal?) -> Bool {
        signal == .working || signal == .needsYou
    }

    static func frameIndex(at date: Date) -> Int {
        Int((date.timeIntervalSinceReferenceDate / frameInterval).rounded(.down)) % backgroundFrameCount
    }

    /// The clock frame a drawing uses. Faster loops repeat within the clock's count, so their images are shared.
    static func loopFrame(_ frame: Int, background: Bool) -> Int {
        background ? frame % backgroundFrameCount : frame % frameCount
    }
}

extension SessionSignal {
    /// Tint of the dithered corner. Attention states use the shared signal colors.
    var tint: Color {
        switch self {
        case .working: Theme.working
        case .failed: Theme.destructive
        case .needsYou: Theme.warning
        case .readyToMerge: Theme.success
        }
    }
}

private struct DitherCornerModifier: ViewModifier {
    let signal: SessionSignal?
    let background: Bool
    let outset: EdgeInsets
    let cornerRadius: CGFloat
    let extent: Double
    let recedes: Bool
    let monochrome: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The drawn state lags `signal` by one update, so a change starts its dissolve from the old state.
    @State private var shown: SessionSignal?
    @State private var previous: SessionSignal?
    @State private var mix = 1.0
    @State private var hovered = false

    init(signal: SessionSignal?, background: Bool, outset: EdgeInsets, cornerRadius: CGFloat, extent: Double,
         recedes: Bool, monochrome: Bool) {
        self.signal = signal
        self.background = background
        self.outset = outset
        self.cornerRadius = cornerRadius
        self.extent = extent
        self.recedes = recedes
        self.monochrome = monochrome
        _shown = State(initialValue: signal)
    }

    func body(content: Content) -> some View {
        content
            .environment(\.rowHasDitherCorner, true)
            .background {
                if shown != nil || (previous != nil && mix < 1) {
                    DitherCornerClocked(signal: shown, background: background && shown == .working,
                                        previous: previous, mix: mix, recede: recedes && hovered ? 1 : 0,
                                        still: reduceMotion, extent: extent, monochrome: monochrome)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(outset)
                        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
                        .allowsHitTesting(false)
                        .accessibilityElement()
                        .accessibilityLabel(shown.map { "Status: \($0.label)\(background ? " in the background" : "")" } ?? "")
                        .accessibilityHidden(shown == nil)
                }
            }
            .onHover { inside in
                if recedes, inside != hovered { hovered = inside }
            }
            .onChange(of: signal) { old, new in
                guard new != shown else { return }
                var instant = Transaction()
                instant.disablesAnimations = true
                withTransaction(instant) {
                    previous = shown ?? old
                    shown = new
                    mix = 0
                }
                // The next update dissolves from the old state into the new one.
                DispatchQueue.main.async {
                    withAnimation(.easeInOut(duration: 0.6)) { mix = 1 }
                }
            }
    }
}

/// Observes the shared clock only while something on the corner moves.
private struct DitherCornerClocked: View {
    let signal: SessionSignal?
    let background: Bool
    let previous: SessionSignal?
    let mix: Double
    let recede: Double
    let still: Bool
    let extent: Double
    let monochrome: Bool

    var body: some View {
        let moving = !still && (DitherCorner.animates(signal) || (mix < 1 && DitherCorner.animates(previous)))
        if moving {
            DitherCornerTicking { frame in layer(frame: frame) }
        } else {
            layer(frame: 0)
        }
    }

    private func layer(frame: Int) -> some View {
        DitherCornerLayer(signal: signal, background: background, previous: previous, frame: frame, mix: mix,
                          recede: recede, extent: extent, monochrome: monochrome)
            .animation(still ? nil : DitherCorner.recedeAnimation, value: recede)
    }
}

/// Redraws `content` on each shared clock frame while it is on screen. Also drives `DotGridSpinner`.
struct DitherCornerTicking<Content: View>: View {
    @ViewBuilder let content: (Int) -> Content
    @ObservedObject private var clock = DitherCornerClock.shared
    @StateObject private var lifetime = DitherCornerClockLifetime()

    var body: some View {
        content(clock.frameIndex)
            .onAppear { lifetime.start() }
            .onDisappear { lifetime.stop() }
    }
}

/// Recession and dissolve progress are animatable, so both redraw the dither each frame while they move.
private struct DitherCornerLayer: View, Animatable {
    let signal: SessionSignal?
    let background: Bool
    let previous: SessionSignal?
    let frame: Int
    var mix: Double
    var recede: Double
    let extent: Double
    let monochrome: Bool

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(mix, recede) }
        set {
            mix = newValue.first
            recede = newValue.second
        }
    }

    var body: some View {
        let request = DitherCornerRequest(signal: signal, previous: mix < 1 ? previous : nil,
                                          frame: DitherCorner.loopFrame(frame, background: background),
                                          mix: min(1, max(0, mix)), recede: min(1, max(0, recede)), extent: extent,
                                          background: background, monochrome: monochrome)
        if let image = DitherCornerRenderer.image(for: request) {
            let grid = DitherCorner.grid(extent: extent)
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .frame(width: CGFloat(grid.columns) * DitherCorner.cell, height: CGFloat(grid.rows) * DitherCorner.cell)
        }
    }
}

// MARK: - Rendering

struct DitherCornerRequest: Hashable {
    var signal: SessionSignal?
    var previous: SessionSignal?
    var frame: Int
    var mix: Double = 1
    /// 0 at rest, 1 fully receded under the pointer. See `DitherCorner.recededReach`.
    var recede: Double = 0
    /// See `ditherCorner(_:outset:cornerRadius:extent:recedes:)`. Few distinct values, so the cache stays bounded.
    var extent: Double = 1
    /// A working corner whose agent waits on background jobs: fainter and half as fast.
    var background = false
    /// Grey for states that do not need the user, as in the command palette.
    var monochrome = false

    /// Resting and fully receded corners repeat across rows and frames. Dissolving and mid-recession ones are
    /// one-offs.
    var isCacheable: Bool { previous == nil && mix >= 1 && (recede == 0 || recede == 1) }
}

/// Renders on the main actor: a corner is about 1,250 cells, a few microseconds of arithmetic, and only a
/// dissolving row, or the hovered one while it recedes, renders outside the cache.
@MainActor
enum DitherCornerRenderer {
    /// Bounded by construction: four signals times `frameCount` frames, plus `backgroundFrameCount` for the
    /// background ripple, at rest and fully receded, per extent in use, about 5 KB each for rows (the question tray's larger corner is about
    /// 30 KB per frame, and only needs you; the composer's working corner, `ComposerCorner.extent`, about 11 KB per
    /// frame, working only, never receded).
    private static var cache: [DitherCornerRequest: CGImage] = [:]

    static func image(for request: DitherCornerRequest) -> CGImage? {
        if request.isCacheable, let image = cache[request] { return image }
        guard request.signal != nil || request.previous != nil else { return nil }
        let image = render(request)
        if request.isCacheable, let image { cache[request] = image }
        return image
    }

    static var cachedCount: Int { cache.count }

    private static let bayer: [Double] = [
        0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
        3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
    ].map { ($0 + 0.5) / 64 }

    private static var tints: [SessionSignal: (Double, Double, Double)] = {
        var tints: [SessionSignal: (Double, Double, Double)] = [:]
        for signal in SessionSignal.allCases {
            let color = NSColor(signal.tint).usingColorSpace(.sRGB) ?? .gray
            tints[signal] = (Double(color.redComponent), Double(color.greenComponent), Double(color.blueComponent))
        }
        return tints
    }()

    /// The monochrome tint of states that do not need the user.
    private static let quietTint: (Double, Double, Double) = {
        let color = NSColor(Theme.faintForeground).usingColorSpace(.sRGB) ?? .gray
        return (Double(color.redComponent), Double(color.greenComponent), Double(color.blueComponent))
    }()

    /// Coverage in 0...1 of one cell. `u` and `v` are the cell's distance in cells from the right and bottom.
    nonisolated static func coverage(_ signal: SessionSignal?, u: Double, v: Double, frame: Int, recede: Double = 0,
                                     extent: Double = 1, background: Bool = false) -> Double {
        guard let signal else { return 0 }
        // Anchored at the corner. Receding draws the reach in toward it, so the same cells hold a smaller corner.
        let reachX = 1 - (1 - DitherCorner.recededReach.x) * recede
        let reachY = 1 - (1 - DitherCorner.recededReach.y) * recede
        let dx = u / (46 * extent * reachX)
        let dy = v / (25 * extent * reachY)
        let distance = (dx * dx + dy * dy).squareRoot()
        var field = max(0, 1 - distance)
        field = field * field * (3 - 2 * field)
        let phase = 2 * Double.pi * Double(frame) / Double(DitherCorner.frameCount)
        let level: Double
        switch signal {
        case .working where background:
            let slow = 2 * Double.pi * Double(frame) / Double(DitherCorner.backgroundFrameCount)
            level = 0.36 + 0.12 * (0.5 + 0.5 * sin(distance * 10 - slow))
        case .working: level = 0.42 + 0.26 * (0.5 + 0.5 * sin(distance * 14 - phase))
        case .needsYou: level = 0.5 + 0.22 * (0.5 + 0.5 * sin(phase))
        case .failed: level = 0.68
        case .readyToMerge: level = 0.55
        }
        return field * level
    }

    private static func render(_ request: DitherCornerRequest) -> CGImage? {
        let (width, height) = DitherCorner.grid(extent: request.extent)
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0 ..< height {
            let v = Double(height - y) - 0.5
            for x in 0 ..< width {
                let u = Double(width - x) - 0.5
                let threshold = bayer[(y & 7) * 8 + (x & 7)]
                // Each cell flips to the new state at its own threshold, so the change dissolves.
                let signal = request.previous != nil && threshold > request.mix ? request.previous : request.signal
                let amount = coverage(signal, u: u, v: v, frame: request.frame, recede: request.recede,
                                      extent: request.extent, background: request.background && signal == request.signal)
                guard let signal, threshold < amount,
                      let tint = request.monochrome && !signal.needsUser ? quietTint : tints[signal] else { continue }
                let alpha = 0.62 * (0.55 + 0.45 * amount)
                let index = (y * width + x) * 4
                pixels[index] = UInt8(clamping: Int(tint.0 * alpha * 255))
                pixels[index + 1] = UInt8(clamping: Int(tint.1 * alpha * 255))
                pixels[index + 2] = UInt8(clamping: Int(tint.2 * alpha * 255))
                pixels[index + 3] = UInt8(clamping: Int(alpha * 255))
            }
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )
    }
}

// MARK: - Clock

/// One publication per tick for animated corners and working ripples. Runs only while a working or
/// needs-you corner is on screen, and skips ticks while the app is hidden or has no visible window.
@MainActor
final class DitherCornerClock: ObservableObject {
    static let shared = DitherCornerClock()
    @Published private(set) var frameIndex = DitherCorner.frameIndex(at: .now)
    private var subscribers: Set<UUID> = []
    private var timer: Timer?
    var subscriberCount: Int { subscribers.count }
    var isRunning: Bool { timer?.isValid == true }

    func subscribe(_ id: UUID) {
        guard subscribers.insert(id).inserted, timer == nil else { return }
        refresh(at: .now)
        let timer = Timer(timeInterval: DitherCorner.frameInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard NSApp?.isHidden != true,
                      NSApp?.windows.contains(where: { $0.isVisible }) == true else { return }
                self?.refresh(at: .now)
            }
        }
        timer.tolerance = 0.02
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
        let next = DitherCorner.frameIndex(at: date)
        if next != frameIndex { frameIndex = next }
    }

    deinit { timer?.invalidate() }
}

@MainActor
private final class DitherCornerClockLifetime: ObservableObject {
    private let id = UUID()
    func start() { DitherCornerClock.shared.subscribe(id) }
    func stop() { DitherCornerClock.shared.unsubscribe(id) }
    deinit {
        let id = id
        Task { @MainActor in DitherCornerClock.shared.unsubscribe(id) }
    }
}
