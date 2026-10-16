import CoreGraphics
import Foundation

/// Sizing for diagrams and pictures in chat: natural size, centered, shrink only. Inline blocks are
/// at most the column width and `inlineMaxHeight` tall; only the expanded viewer may enlarge them.
public enum DiagramLayout {
    /// Ceiling for an inline block, including its padding.
    public static let inlineMaxHeight: CGFloat = 480
    /// Keeps a tiny or failed drawing large enough to click.
    public static let inlineMinHeight: CGFloat = 60
    /// Inset between the block edge and the drawing.
    public static let padding: CGFloat = 12
    /// The drawing's own height ceiling inside an inline block.
    public static var inlineDrawingMaxHeight: CGFloat { inlineMaxHeight - 2 * padding }

    /// Scales `natural` uniformly to fit `bounds` and never enlarges it. Nil for an unusable size.
    public static func fit(_ natural: CGSize, within bounds: CGSize) -> CGSize? {
        guard natural.width.isFinite, natural.height.isFinite, natural.width > 0, natural.height > 0 else { return nil }
        let width = bounds.width.isFinite ? max(0, bounds.width) : natural.width
        let height = bounds.height.isFinite ? max(0, bounds.height) : natural.height
        if natural.width <= width, natural.height <= height { return natural }
        // Pin the limiting side exactly and derive the other with one division, so whole-point
        // results stay whole and the row height does not round up by a stray epsilon.
        if width / natural.width <= height / natural.height {
            return CGSize(width: width, height: natural.height * width / natural.width)
        }
        return CGSize(width: natural.width * height / natural.height, height: height)
    }

    /// The drawing's fitted size inside an inline block of `availableWidth`.
    public static func inlineDrawingSize(natural: CGSize, availableWidth: CGFloat) -> CGSize? {
        fit(natural, within: CGSize(width: max(0, availableWidth - 2 * padding), height: inlineDrawingMaxHeight))
    }

    /// Height of the inline block, so the row can be sized before (or without) measuring the page.
    public static func inlineHeight(natural: CGSize, availableWidth: CGFloat) -> CGFloat? {
        guard availableWidth.isFinite, availableWidth > 0,
              let drawing = inlineDrawingSize(natural: natural, availableWidth: availableWidth) else { return nil }
        return min(inlineMaxHeight, max(inlineMinHeight, ceil(drawing.height) + 2 * padding))
    }

    /// Clamps a height measured from a rendered page into the inline bounds. Nil when not finite.
    public static func inlineHeight(measured: CGFloat) -> CGFloat? {
        guard measured.isFinite else { return nil }
        return min(inlineMaxHeight, max(inlineMinHeight, ceil(measured)))
    }
}

/// Last measured sizes of lazily recreated content, bounded by count. Storing a key again makes it
/// the newest; the oldest entries are evicted first. Entries round-trip for persistence across launches.
public struct MeasuredSizeMemory: Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let key: String
        public let width: Double
        public let height: Double

        public init(key: String, width: Double, height: Double) {
            self.key = key
            self.width = width
            self.height = height
        }
    }

    public let limit: Int
    private var order: [String] = []
    private var sizes: [String: CGSize] = [:]

    public init(limit: Int, entries: [Entry] = []) {
        self.limit = max(1, limit)
        // Persisted data is untrusted: skip invalid sizes, keep the newest entries within the limit.
        for entry in entries { store(CGSize(width: entry.width, height: entry.height), for: entry.key) }
    }

    public var count: Int { order.count }

    public subscript(key: String) -> CGSize? { sizes[key] }

    /// Oldest first, so restoring them in order preserves recency.
    public var entries: [Entry] {
        order.compactMap { key in sizes[key].map { Entry(key: key, width: $0.width, height: $0.height) } }
    }

    /// Returns whether the stored value changed.
    @discardableResult
    public mutating func store(_ size: CGSize, for key: String) -> Bool {
        guard !key.isEmpty, size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return false }
        if let existing = sizes[key] {
            if order.last != key {
                order.removeAll { $0 == key }
                order.append(key)
            }
            guard existing != size else { return false }
        } else {
            order.append(key)
        }
        sizes[key] = size
        while order.count > limit { sizes[order.removeFirst()] = nil }
        return true
    }
}
