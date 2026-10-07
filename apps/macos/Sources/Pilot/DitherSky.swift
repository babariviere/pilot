import AppKit
import SwiftUI

/// A procedural light sky with clouds and a far shoreline, drawn with an ordered (Bayer) dither
/// of its lightness and dissolving dot by dot into the page at its foot. Rendered once per size,
/// at one pixel per `cell` points, and scaled up with hard pixels.
struct DitherSky: View {
    var cell: CGFloat = 2
    var fade: Double = 0.45

    @StateObject private var sky = SkyImageState()

    var body: some View {
        GeometryReader { geometry in
            let width = max(1, Int(geometry.size.width / cell))
            let height = max(1, Int(geometry.size.height / cell))
            let key = SkyRenderKey(width: width, height: height, fade: fade)
            ZStack(alignment: .topLeading) {
                // Geometry can change before its task starts. Never display the old size's image.
                if let rendered = sky.rendered, rendered.key == key {
                    Image(decorative: rendered.image, scale: 1)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: CGFloat(width) * cell, height: CGFloat(height) * cell)
                }
            }
            .task(id: key) { await sky.load(key) }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct SkyRenderKey: Hashable, Sendable {
    let width: Int
    let height: Int
    let fade: Double
}

@MainActor
private final class SkyImageState: ObservableObject {
    struct Rendered {
        let key: SkyRenderKey
        let image: CGImage
    }

    @Published private(set) var rendered: Rendered?
    private var requestedKey: SkyRenderKey?

    func load(_ key: SkyRenderKey) async {
        guard !Task.isCancelled else { return }
        requestedKey = key
        rendered = nil
        let image = await SkyRenderer.shared.image(for: key)
        guard !Task.isCancelled, requestedKey == key, let image else { return }
        rendered = Rendered(key: key, image: image)
    }
}

/// Serial actor isolation keeps pixel generation off the main actor, and limits concurrent
/// allocations. The caller's task cancellation is checked while rendering and before caching.
private actor SkyRenderer {
    static let shared = SkyRenderer()

    private struct Entry {
        let key: SkyRenderKey
        let image: CGImage
        let bytes: Int
    }

    private var cache: [Entry] = [] // Least recently used first.
    private var cachedBytes = 0
    private let maximumEntries = 8
    private let maximumBytes = 16 * 1024 * 1024

    func image(for key: SkyRenderKey) -> CGImage? {
        guard !Task.isCancelled else { return nil }
        if let index = cache.firstIndex(where: { $0.key == key }) {
            let entry = cache.remove(at: index)
            cache.append(entry)
            return entry.image
        }
        guard let image = Self.render(width: key.width, height: key.height, fade: key.fade),
              !Task.isCancelled else { return nil }
        let bytes = image.bytesPerRow * image.height
        // Oversized images can still be displayed, but must not expand the shared cache.
        if bytes <= maximumBytes {
            while cache.count >= maximumEntries || cachedBytes + bytes > maximumBytes {
                cachedBytes -= cache.removeFirst().bytes
            }
            cache.append(Entry(key: key, image: image, bytes: bytes))
            cachedBytes += bytes
        }
        return image
    }

    private static let bayer: [Double] = [
        0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
        3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
    ].map { ($0 + 0.5) / 64 }

    private static func render(width: Int, height: Int, fade: Double) -> CGImage? {
        guard width > 0, height > 0, fade.isFinite, !Task.isCancelled else { return nil }
        let (pixelCount, pixelOverflow) = width.multipliedReportingOverflow(by: height)
        let (byteCount, byteOverflow) = pixelCount.multipliedReportingOverflow(by: 4)
        guard !pixelOverflow, !byteOverflow else { return nil }
        var pixels = [UInt8](repeating: 0, count: byteCount)
        let top = (0.36, 0.58, 0.87)
        let horizon = (0.84, 0.91, 0.98)
        let sea = (0.70, 0.80, 0.91)
        let levels = 9.0
        // Same scene at any width: sample in a fixed-height space.
        let scale = 150.0 / Double(height)
        for y in 0 ..< height {
            guard !Task.isCancelled else { return nil }
            let t = Double(y) / Double(max(1, height - 1))
            for x in 0 ..< width {
                let u = Double(x) * scale
                let v = Double(y) * scale
                var color = mix(top, horizon, smoothstep(0, 0.8, t))

                // Cumulus: domain-warped fractal noise, stretched wide, thinning toward the horizon.
                let warp = fbm(u * 0.01 + 3.1, v * 0.02 + 1.7)
                let cu = u * 0.016 + warp * 1.6
                let cv = v * 0.045 + warp * 0.8
                let n = fbm(cu, cv)
                let band = 1 - smoothstep(0.35, 0.72, t)
                let density = smoothstep(0.50, 0.66, n) * band
                // Lit tops, cooler undersides: compare with the noise a little higher up.
                let above = fbm(cu, cv - 0.18)
                let light = 0.86 + 0.14 * smoothstep(-0.04, 0.06, above - n)
                let cloud = (light * 0.98, light * 0.99, min(1, light * 1.02 + 0.02))
                color = mix(color, cloud, density)

                // A calm sea below the horizon, with faint streaks.
                if t > 0.74 {
                    let streak = 0.03 * (fbm(u * 0.004, v * 0.6) - 0.5)
                    color = mix(color, (sea.0 + streak, sea.1 + streak, sea.2 + streak), 0.9)
                }

                // Ordered dither of lightness, keeping hue smooth.
                let threshold = bayer[(y & 7) * 8 + (x & 7)]
                let lightness = (color.0 + color.1 + color.2) / 3
                let quantized = (floor(lightness * levels + threshold) / levels)
                let factor = lightness > 0 ? quantized / lightness : 1
                color = (color.0 * factor, color.1 * factor, color.2 * factor)

                // Dissolve into the page toward the foot.
                var alpha = 1.0
                let start = 1 - fade
                if t > start, threshold < (t - start) / fade { alpha = 0 }

                let index = (y * width + x) * 4
                pixels[index] = UInt8(clamping: Int(min(1, color.0) * alpha * 255))
                pixels[index + 1] = UInt8(clamping: Int(min(1, color.1) * alpha * 255))
                pixels[index + 2] = UInt8(clamping: Int(min(1, color.2) * alpha * 255))
                pixels[index + 3] = UInt8(clamping: Int(alpha * 255))
            }
        }
        guard !Task.isCancelled else { return nil }
        let data = Data(pixels) as CFData
        guard let provider = CGDataProvider(data: data) else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )
    }

    private static func smoothstep(_ a: Double, _ b: Double, _ x: Double) -> Double {
        let t = min(1, max(0, (x - a) / (b - a)))
        return t * t * (3 - 2 * t)
    }

    private static func mix(_ a: (Double, Double, Double), _ b: (Double, Double, Double), _ t: Double) -> (Double, Double, Double) {
        (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, a.2 + (b.2 - a.2) * t)
    }

    private static func hash(_ x: Int, _ y: Int) -> Double {
        var h = UInt32(truncatingIfNeeded: x &* 374_761_393 &+ y &* 668_265_263)
        h = (h ^ (h >> 13)) &* 1_274_126_177
        h ^= h >> 16
        return Double(h & 0xFFFF) / 65535
    }

    private static func noise(_ x: Double, _ y: Double) -> Double {
        let xi = Int(floor(x)), yi = Int(floor(y))
        let xf = x - floor(x), yf = y - floor(y)
        let u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
        let a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
    }

    private static func fbm(_ x: Double, _ y: Double) -> Double {
        var value = 0.0, amplitude = 0.5, frequency = 1.0
        for _ in 0 ..< 5 {
            value += amplitude * noise(x * frequency, y * frequency)
            frequency *= 2
            amplitude *= 0.5
        }
        return value
    }
}
