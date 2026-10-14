import AppKit
import SwiftUI

/// A small strip of ordered (Bayer) dither in Theme.working that ripples left to right: the sign of live work,
/// in place of a spinner or shimmer. `background` is fainter and half as fast, for an agent that is idle
/// while its background jobs run (the same motion as a background working corner).
///
/// It draws on the shared corner clock, so only this strip redraws each frame, never the view around it. Reduce
/// Motion keeps it still. It is decorative: the text beside it carries the state for VoiceOver.
struct DitherRipple: View {
    var background = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static var columns: Int { DitherRippleRenderer.columns }
    static var rows: Int { DitherRippleRenderer.rows }

    var body: some View {
        Group {
            if reduceMotion {
                strip(frame: DitherRipple.stillFrame)
            } else {
                DitherCornerTicking { frame in strip(frame: frame) }
            }
        }
        .frame(width: CGFloat(Self.columns) * DitherCorner.cell, height: CGFloat(Self.rows) * DitherCorner.cell)
        .accessibilityHidden(true)
    }

    /// A frame with the crest mid-strip, for Reduce Motion.
    static let stillFrame = 9

    @ViewBuilder private func strip(frame: Int) -> some View {
        if let image = DitherRippleRenderer.image(frame: DitherCorner.loopFrame(frame, background: background),
                                                  background: background) {
            Image(decorative: image, scale: 1).interpolation(.none).resizable()
        }
    }
}

@MainActor
enum DitherRippleRenderer {
    nonisolated static let columns = 20
    nonisolated static let rows = 6
    private struct Key: Hashable { let frame: Int; let background: Bool }
    /// Bounded: `frameCount` plus `backgroundFrameCount` images of 20 × 6 pixels.
    private static var cache: [Key: CGImage] = [:]
    static var cachedCount: Int { cache.count }

    private static let bayer: [Double] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map { ($0 + 0.5) / 16 }

    private static let tint: (Double, Double, Double) = {
        let color = NSColor(Theme.working).usingColorSpace(.sRGB) ?? .systemIndigo
        return (Double(color.redComponent), Double(color.greenComponent), Double(color.blueComponent))
    }()

    static func image(frame: Int, background: Bool) -> CGImage? {
        let key = Key(frame: frame, background: background)
        if let image = cache[key] { return image }
        let image = render(frame: frame, background: background)
        if let image { cache[key] = image }
        return image
    }

    /// Coverage in 0...1 of the cell at `x`, `y`: a crest travelling rightwards, fading toward the strip's ends
    /// and its top and bottom rows.
    nonisolated static func coverage(x: Int, y: Int, frame: Int, background: Bool) -> Double {
        let u = (Double(x) + 0.5) / Double(columns)
        let v = (Double(y) + 0.5) / Double(rows)
        let loop = Double(background ? DitherCorner.backgroundFrameCount : DitherCorner.frameCount)
        let phase = 2 * Double.pi * Double(frame) / loop
        let wave = 0.5 + 0.5 * sin(u * 2 * Double.pi * 1.5 - phase)
        let ends = min(1, u * 5, (1 - u) * 5)
        let band = max(0, 1 - abs(v - 0.5) * 1.3)
        let level = background ? 0.16 + 0.34 * wave : 0.2 + 0.72 * wave
        return level * ends * band
    }

    private static func render(frame: Int, background: Bool) -> CGImage? {
        let width = columns, height = rows
        let alpha = background ? 0.6 : 0.85
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0 ..< height {
            for x in 0 ..< width where bayer[(y & 3) * 4 + (x & 3)] < coverage(x: x, y: y, frame: frame, background: background) {
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
