import AppKit
import MermaidLayout
import MermaidRender
import PilotCore
import SwiftUI

/// A Mermaid source the native renderer accepted: its parsed model and natural size, known before
/// anything is drawn so the transcript row has its final height from the start.
struct NativeMermaidLayout: Sendable, Equatable {
    let diagram: MermaidDiagram
    let natural: CGSize
    let altText: String

    /// Flowchart link labels as drawn, for checks that the parse matched the source.
    var edgeLabels: [String] {
        guard case let .flowchart(chart) = diagram else { return [] }
        return chart.edges.compactMap(\.label)
    }
}

/// Native Mermaid for chat. Parsing and layout run where Markdown is prepared (off the main actor), and
/// bitmaps are drawn on a background actor at the block's size, cached by source, appearance and size.
/// Sources the native parser cannot read faithfully return nil and keep the WebView renderer.
enum NativeMermaid {
    private final class LayoutCache: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [String: NativeMermaidLayout?] = [:]
        private var order: [String] = []
        let limit = 256

        func value(_ source: String, make: () -> NativeMermaidLayout?) -> NativeMermaidLayout? {
            lock.lock()
            if let cached = entries[source] {
                lock.unlock()
                return cached
            }
            lock.unlock()
            let value = make()
            lock.lock()
            defer { lock.unlock() }
            if entries.updateValue(value, forKey: source) == nil {
                order.append(source)
                while order.count > limit { entries[order.removeFirst()] = nil }
            }
            return value
        }
    }

    private static let layouts = LayoutCache()

    /// Performance comparisons only: route every diagram to the WebView renderer.
    nonisolated(unsafe) static var webOnly = false

    /// Parse, validate and lay out once per source. Nil when the source should use the web renderer.
    static func layout(_ source: String) -> NativeMermaidLayout? {
        // The native parser rejects sources over 50,000 characters; do not retain them as cache keys.
        if webOnly || source.utf8.count > 64 * 1024 { return nil }
        return layouts.value(source) { makeLayout(source) }
    }

    static func makeLayout(_ source: String) -> NativeMermaidLayout? {
        guard let diagram = MermaidParser.parse(source) else { return nil }
        if case .flowchart = diagram {
            // The parser skips link statements it cannot read. Never show a diagram with links missing.
            for statement in MermaidSource.linkStatements(source) {
                guard case let .flowchart(single)? = MermaidParser.parse("flowchart TD\n" + statement),
                      !single.edges.isEmpty else { return nil }
            }
        }
        guard let image = MermaidRenderer.image(diagram: diagram, theme: theme(dark: false)) else { return nil }
        let natural = image.size
        guard natural.width.isFinite, natural.height.isFinite, natural.width > 0, natural.height > 0 else { return nil }
        return NativeMermaidLayout(diagram: diagram, natural: natural, altText: MermaidRenderer.altText(diagram: diagram))
    }

    /// Theme tokens: text ramp, chat background, hairline borders and the working indigo as accent.
    static func theme(dark: Bool) -> DiagramTheme { dark ? darkTheme : lightTheme }
    private static let lightTheme = makeTheme(dark: false)
    private static let darkTheme = makeTheme(dark: true)
    private static func makeTheme(dark: Bool) -> DiagramTheme {
        DiagramTheme(ink: NSColor(Theme.foreground), secondaryTextColor: NSColor(Theme.mutedForeground),
                     tertiaryTextColor: NSColor(Theme.faintForeground), canvas: NSColor(Theme.background),
                     accent: NSColor(Theme.workingInk), hairline: NSColor(Theme.border), prefersDark: dark)
    }

    struct ImageKey: Hashable, Sendable {
        let source: String
        let dark: Bool
        /// Bitmap size in pixels.
        let width: Int
        let height: Int
    }

    private final class ImageBox {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    /// Bounded by decoded bytes, so many large diagrams cannot grow memory without limit.
    private static let images: NSCache<NSString, ImageBox> = {
        let cache = NSCache<NSString, ImageBox>()
        cache.totalCostLimit = 48 * 1024 * 1024
        cache.countLimit = 64
        return cache
    }()

    private static func cacheKey(_ key: ImageKey) -> NSString {
        "\(key.dark ? 1 : 0)|\(key.width)x\(key.height)|\(key.source)" as NSString
    }

    static func cachedImage(_ key: ImageKey) -> CGImage? { images.object(forKey: cacheKey(key))?.image }

    /// Draws off the main actor, one diagram at a time, and skips work for blocks that left the view.
    static func image(_ layout: NativeMermaidLayout, key: ImageKey) async -> CGImage? {
        if let cached = cachedImage(key) { return cached }
        guard let image = await NativeMermaidRenderer.shared.draw(layout, key: key) else { return nil }
        images.setObject(ImageBox(image), forKey: cacheKey(key), cost: image.bytesPerRow * image.height)
        return image
    }
}

private actor NativeMermaidRenderer {
    static let shared = NativeMermaidRenderer()
    /// Largest bitmap side in pixels. The expanded viewer draws vectors, so this only bounds inline memory.
    private let maxSide = 4096

    func draw(_ layout: NativeMermaidLayout, key: NativeMermaid.ImageKey) -> CGImage? {
        guard !Task.isCancelled, key.width > 0, key.height > 0, key.width <= maxSide, key.height <= maxSide,
              let image = MermaidRenderer.image(diagram: layout.diagram, theme: NativeMermaid.theme(dark: key.dark)),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: key.width, height: key.height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        context.interpolationQuality = .high
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        image.draw(in: CGRect(x: 0, y: 0, width: key.width, height: key.height))
        NSGraphicsContext.restoreGraphicsState()
        return Task.isCancelled ? nil : context.makeImage()
    }
}
