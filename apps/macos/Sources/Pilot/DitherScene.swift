import AppKit
import SwiftUI

/// A bundled painting of a calm coast (`Resources/CoastScene.png`), drawn in the pixel language of `DitherSky`:
/// sampled at one pixel per `cell` points, its lightness ordered-dithered (Bayer) with hard pixels, and dissolving
/// dot by dot into the page at its foot. Rendered off the main actor once per size and cached. Falls back to the
/// procedural `DitherSky` when the image is missing.
///
/// Use it for a large, restful moment such as an empty Inbox. Keep `DitherSky` for Home.
struct DitherScene: View {
    /// Finer than the Home sky, so the painting keeps its detail while its pixels stay hard.
    var cell: CGFloat = 1.5
    var fade: Double = 0.22

    @StateObject private var scene = SceneImageState()

    var body: some View {
        GeometryReader { geometry in
            let width = max(1, Int(geometry.size.width / cell))
            let height = max(1, Int(geometry.size.height / cell))
            let key = DitherSceneKey(width: width, height: height, fade: fade)
            ZStack(alignment: .topLeading) {
                if scene.missing {
                    DitherSky(cell: cell, fade: fade)
                } else if let rendered = scene.rendered, rendered.key == key {
                    // Geometry can change before its task starts. Never display the old size's image.
                    Image(decorative: rendered.image, scale: 1)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: CGFloat(width) * cell, height: CGFloat(height) * cell)
                }
            }
            .task(id: key) { await scene.load(key) }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct DitherSceneKey: Hashable, Sendable {
    let width: Int
    let height: Int
    let fade: Double
}

@MainActor
private final class SceneImageState: ObservableObject {
    struct Rendered {
        let key: DitherSceneKey
        let image: CGImage
    }

    @Published private(set) var rendered: Rendered?
    @Published private(set) var missing = false
    private var requestedKey: DitherSceneKey?

    func load(_ key: DitherSceneKey) async {
        guard !Task.isCancelled else { return }
        requestedKey = key
        rendered = nil
        switch await SceneRenderer.shared.image(for: key) {
        case let .image(image):
            guard !Task.isCancelled, requestedKey == key else { return }
            rendered = Rendered(key: key, image: image)
        case .missing:
            missing = true
        case .cancelled:
            break
        }
    }
}

/// Serial actor isolation keeps decoding and pixel work off the main actor and bounds allocations.
private actor SceneRenderer {
    enum Outcome {
        case image(CGImage)
        case missing
        case cancelled
    }

    static let shared = SceneRenderer()

    private struct Entry {
        let key: DitherSceneKey
        let image: CGImage
        let bytes: Int
    }

    /// Decoded once, on first use.
    private var source: CGImage??
    private var cache: [Entry] = [] // Least recently used first.
    private var cachedBytes = 0
    private let maximumEntries = 4
    private let maximumBytes = 8 * 1024 * 1024

    func image(for key: DitherSceneKey) -> Outcome {
        guard !Task.isCancelled else { return .cancelled }
        if let index = cache.firstIndex(where: { $0.key == key }) {
            let entry = cache.remove(at: index)
            cache.append(entry)
            return .image(entry.image)
        }
        if source == nil { source = DitherSceneRenderer.loadSource() }
        guard let source = source ?? nil else { return .missing }
        guard let image = DitherSceneRenderer.render(source, width: key.width, height: key.height, fade: key.fade),
              !Task.isCancelled else { return .cancelled }
        let bytes = image.bytesPerRow * image.height
        if bytes <= maximumBytes {
            while cache.count >= maximumEntries || cachedBytes + bytes > maximumBytes {
                cachedBytes -= cache.removeFirst().bytes
            }
            cache.append(Entry(key: key, image: image, bytes: bytes))
            cachedBytes += bytes
        }
        return .image(image)
    }
}

enum DitherSceneRenderer {
    static let resource = "CoastScene"

    /// The app's SwiftPM resource bundle: in Contents/Resources when packaged, beside the binary in a build.
    /// Looked up by hand because `Bundle.module` traps when its bundle is missing.
    static func sourceURL(main: Bundle = .main) -> URL? {
        let name = "PilotMac_Pilot.bundle"
        let candidates = [main.resourceURL?.appending(path: name), main.bundleURL.appending(path: name)]
        for url in candidates.compactMap({ $0 }) {
            if let found = Bundle(url: url)?.url(forResource: resource, withExtension: "png") { return found }
        }
        return nil
    }

    static func loadSource(url: URL? = sourceURL()) -> CGImage? {
        guard let url, let data = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(data, 0, nil)
    }

    private static let bayer: [Double] = [
        0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
        3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
    ].map { ($0 + 0.5) / 64 }

    /// Samples `source` to fill `width` x `height` pixels (centered, cropped to the aspect), then dithers its
    /// lightness in `levels` steps, keeping hue smooth, and dissolves the bottom `fade` of the height.
    static func render(_ source: CGImage, width: Int, height: Int, fade: Double, levels: Double = 16) -> CGImage? {
        guard width > 0, height > 0, width <= 4096, height <= 4096, fade.isFinite, !Task.isCancelled,
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        let scale = max(Double(width) / Double(source.width), Double(height) / Double(source.height))
        let drawn = CGSize(width: Double(source.width) * scale, height: Double(source.height) * scale)
        context.interpolationQuality = .high
        context.draw(source, in: CGRect(x: (Double(width) - drawn.width) / 2, y: (Double(height) - drawn.height) / 2,
                                        width: drawn.width, height: drawn.height))
        guard let data = context.data else { return nil }
        let pixels = data.bindMemory(to: UInt8.self, capacity: width * height * 4)
        let start = 1 - fade
        for y in 0 ..< height {
            guard !Task.isCancelled else { return nil }
            let t = Double(y) / Double(max(1, height - 1))
            for x in 0 ..< width {
                let index = (y * width + x) * 4
                let alpha = Double(pixels[index + 3]) / 255
                guard alpha > 0 else { continue }
                // Unpremultiply, then quantize lightness with the ordered threshold.
                var color = (Double(pixels[index]) / 255 / alpha, Double(pixels[index + 1]) / 255 / alpha,
                             Double(pixels[index + 2]) / 255 / alpha)
                let threshold = bayer[(y & 7) * 8 + (x & 7)]
                let lightness = (color.0 + color.1 + color.2) / 3
                let quantized = floor(lightness * levels + threshold) / levels
                let factor = lightness > 0 ? quantized / lightness : 1
                color = (min(1, color.0 * factor), min(1, color.1 * factor), min(1, color.2 * factor))
                var shown = alpha
                if fade > 0, t > start, threshold < (t - start) / fade { shown = 0 }
                pixels[index] = UInt8(clamping: Int(color.0 * shown * 255))
                pixels[index + 1] = UInt8(clamping: Int(color.1 * shown * 255))
                pixels[index + 2] = UInt8(clamping: Int(color.2 * shown * 255))
                pixels[index + 3] = UInt8(clamping: Int(shown * 255))
            }
        }
        return context.makeImage()
    }
}
