import AppKit
import PilotCore
import SwiftUI

// MARK: - Dithered status corner

/// A row's `SessionSignal`, drawn as an ordered (Bayer) dither that grows from the row's bottom-right corner,
/// in the same pixel language as `DitherSky`. Each state has its own tint, density and motion, so color is
/// never the only signal: working ripples outward, needs you breathes, failed is steady and dense, ready to
/// merge is steady and light. Quiet rows draw nothing. Changes between states dissolve cell by cell, and the
/// corner leans gently toward the pointer while it is over the row.
///
/// Use `.ditherCorner(_:)` on a row's content. Reduce Motion keeps the corner still and drops the lean.
/// Larger surfaces that carry one state, such as the agent question tray, pass their own outset and corner
/// radius so the dither stays inside their shape, and an `extent` above 1 to grow the corner with the surface.
/// Extent adds cells rather than enlarging them, so the pixels stay the sidebar's size.
extension View {
    /// The defaults fit sidebar rows: they reach the edges of the native selection highlight.
    func ditherCorner(_ signal: SessionSignal?,
                      outset: EdgeInsets = EdgeInsets(top: -3, leading: 0, bottom: -3, trailing: -6),
                      cornerRadius: CGFloat = 5, extent: Double = 1) -> some View {
        modifier(DitherCornerModifier(signal: signal, outset: outset, cornerRadius: cornerRadius, extent: extent))
    }
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
    static let frameInterval: TimeInterval = 1.0 / 12
    /// How far the corner reaches toward the pointer, as a fraction of the pointer's distance, in cells.
    static let maximumLean = CGPoint(x: 30, y: 12)

    static func animates(_ signal: SessionSignal?) -> Bool {
        signal == .working || signal == .needsYou
    }

    static func frameIndex(at date: Date) -> Int {
        Int((date.timeIntervalSinceReferenceDate / frameInterval).rounded(.down)) % frameCount
    }

    /// The lean for a pointer at `pointer` in a row of `size`: a fraction of the way from the corner toward the
    /// pointer, in cells. x and y are zero or negative (left and up).
    static func lean(pointer: CGPoint, in size: CGSize) -> CGPoint {
        let x = (pointer.x - size.width) * 0.35 / cell
        let y = (pointer.y - size.height) * 0.5 / cell
        return CGPoint(x: min(0, max(-maximumLean.x, x)), y: min(0, max(-maximumLean.y, y)))
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
    let outset: EdgeInsets
    let cornerRadius: CGFloat
    let extent: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The drawn state lags `signal` by one update, so a change starts its dissolve from the old state.
    @State private var shown: SessionSignal?
    @State private var previous: SessionSignal?
    @State private var mix = 1.0
    @State private var pointer: CGPoint?

    init(signal: SessionSignal?, outset: EdgeInsets, cornerRadius: CGFloat, extent: Double) {
        self.signal = signal
        self.outset = outset
        self.cornerRadius = cornerRadius
        self.extent = extent
        _shown = State(initialValue: signal)
    }

    func body(content: Content) -> some View {
        content
            .background {
                if shown != nil || (previous != nil && mix < 1) {
                    GeometryReader { proxy in
                        let lean = reduceMotion ? .zero : pointer.map { DitherCorner.lean(pointer: $0, in: proxy.size) } ?? .zero
                        DitherCornerClocked(signal: shown, previous: previous, mix: mix, lean: lean,
                                            hover: pointer == nil ? 0 : 1, still: reduceMotion, extent: extent)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    }
                    .padding(outset)
                    .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
                    .allowsHitTesting(false)
                    .accessibilityElement()
                    .accessibilityLabel(shown.map { "Status: \($0.label)" } ?? "")
                    .accessibilityHidden(shown == nil)
                }
            }
            .onContinuousHover { phase in
                switch phase {
                case let .active(location):
                    // Cell-sized steps: finer movement changes no pixels.
                    let snapped = CGPoint(x: (location.x / DitherCorner.cell).rounded() * DitherCorner.cell,
                                          y: (location.y / DitherCorner.cell).rounded() * DitherCorner.cell)
                    if snapped != pointer { pointer = snapped }
                case .ended:
                    pointer = nil
                }
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
    let previous: SessionSignal?
    let mix: Double
    let lean: CGPoint
    let hover: Double
    let still: Bool
    let extent: Double

    var body: some View {
        let moving = !still && (DitherCorner.animates(signal) || (mix < 1 && DitherCorner.animates(previous)))
        if moving {
            DitherCornerTicking { frame in layer(frame: frame) }
        } else {
            layer(frame: 0)
        }
    }

    private func layer(frame: Int) -> some View {
        DitherCornerLayer(signal: signal, previous: previous, frame: frame, mix: mix,
                          leanX: lean.x, leanY: lean.y, hover: hover, extent: extent)
            .animation(still ? nil : .spring(response: 0.5, dampingFraction: 0.78), value: lean)
            .animation(still ? nil : .easeOut(duration: 0.25), value: hover)
    }
}

private struct DitherCornerTicking<Content: View>: View {
    @ViewBuilder let content: (Int) -> Content
    @ObservedObject private var clock = DitherCornerClock.shared
    @StateObject private var lifetime = DitherCornerClockLifetime()

    var body: some View {
        content(clock.frameIndex)
            .onAppear { lifetime.start() }
            .onDisappear { lifetime.stop() }
    }
}

/// Lean, hover and dissolve progress are animatable, so springs and dissolves redraw the dither each frame.
private struct DitherCornerLayer: View, Animatable {
    let signal: SessionSignal?
    let previous: SessionSignal?
    let frame: Int
    var mix: Double
    var leanX: CGFloat
    var leanY: CGFloat
    var hover: Double
    let extent: Double

    var animatableData: AnimatablePair<Double, AnimatablePair<CGFloat, AnimatablePair<CGFloat, Double>>> {
        get { AnimatablePair(mix, AnimatablePair(leanX, AnimatablePair(leanY, hover))) }
        set {
            mix = newValue.first
            leanX = newValue.second.first
            leanY = newValue.second.second.first
            hover = newValue.second.second.second
        }
    }

    var body: some View {
        let request = DitherCornerRequest(signal: signal, previous: mix < 1 ? previous : nil, frame: frame,
                                          mix: min(1, max(0, mix)), leanX: leanX, leanY: leanY,
                                          hover: min(1, max(0, hover)), extent: extent)
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
    /// Cells toward the pointer, zero or negative. See `DitherCorner.lean(pointer:in:)`.
    var leanX: CGFloat = 0
    var leanY: CGFloat = 0
    var hover: Double = 0
    /// See `ditherCorner(_:outset:cornerRadius:extent:)`. Few distinct values, so the cache stays bounded.
    var extent: Double = 1

    /// Resting corners repeat across rows and frames. Pointer-driven and dissolving ones are one-offs.
    var isCacheable: Bool { previous == nil && mix >= 1 && leanX == 0 && leanY == 0 && hover == 0 }
}

/// Renders on the main actor: a corner is about 1,250 cells, a few microseconds of arithmetic, and only the
/// hovered or dissolving row renders outside the cache.
@MainActor
enum DitherCornerRenderer {
    /// Bounded by construction: four signals times `frameCount` resting frames per extent in use, about 5 KB each
    /// for rows (the question tray's larger corner is about 30 KB per frame, and only needs you).
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

    /// Coverage in 0...1 of one cell. `u` and `v` are the cell's distance in cells from the right and bottom.
    nonisolated static func coverage(_ signal: SessionSignal?, u: Double, v: Double, frame: Int, lean: (x: CGFloat, y: CGFloat),
                         hover: Double, extent: Double = 1) -> Double {
        guard let signal else { return 0 }
        let reachX = -Double(lean.x) / Double(DitherCorner.maximumLean.x)
        let reachY = -Double(lean.y) / Double(DitherCorner.maximumLean.y)
        // Anchored at the corner, stretched toward the pointer.
        let dx = u / (46 * extent * (1 + 0.55 * reachX * hover))
        let dy = v / (25 * extent * (1 + 0.6 * reachY * hover))
        let distance = (dx * dx + dy * dy).squareRoot()
        var field = max(0, 1 - distance)
        field = field * field * (3 - 2 * field)
        // A soft swell under the leaning point, so the corner follows the pointer rather than only growing.
        if hover > 0 {
            let bx = (u + Double(lean.x)) / (13 * extent)
            let by = (v + Double(lean.y)) / (8 * extent)
            let swell = max(0, 1 - (bx * bx + by * by).squareRoot())
            field = min(1, field + 0.32 * hover * swell * swell)
        }
        let phase = 2 * Double.pi * Double(frame) / Double(DitherCorner.frameCount)
        let level: Double
        switch signal {
        case .working: level = 0.42 + 0.26 * (0.5 + 0.5 * sin(distance * 14 - phase))
        case .needsYou: level = 0.5 + 0.22 * (0.5 + 0.5 * sin(phase))
        case .failed: level = 0.68
        case .readyToMerge: level = 0.55
        }
        return field * (level + 0.1 * hover)
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
                let amount = coverage(signal, u: u, v: v, frame: request.frame, lean: (request.leanX, request.leanY),
                                      hover: request.hover, extent: request.extent)
                guard let signal, threshold < amount, let tint = tints[signal] else { continue }
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

/// One publication per tick for every animated corner, like `BrailleProgressClock`. Runs only while a working or
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
