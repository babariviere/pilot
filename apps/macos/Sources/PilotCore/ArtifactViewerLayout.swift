import Foundation

/// Expanded previews should fill most of the display, rather than use the sheet's minimum size.
public enum ArtifactViewerLayout {
    public static let inlineDefaultMaxWidth: CGFloat = 1200
    public static let inlineMaxHeight: CGFloat = 1600
    /// Images are scaled to fit, so a tall screenshot stays readable at a glance instead of
    /// filling several screens. The full-size image remains available in the viewer.
    public static let inlineImageMaxHeight: CGFloat = 720
    /// Keeps tiny images large enough to click without letterboxing typical ones.
    public static let inlineImageMinSide: CGFloat = 48

    /// A 4:3 fallback that can grow for content, bounded by chat width and a tall-preview ceiling.
    /// Measured images instead hug their aspect-fitted size, so the card has no empty bands.
    public static func inlineSize(availableWidth: CGFloat, contentSize: CGSize? = nil, image: Bool = false) -> CGSize {
        let available = availableWidth.isFinite ? max(0, availableWidth) : inlineDefaultMaxWidth
        let content = contentSize.flatMap { size in
            size.width.isFinite && size.height.isFinite && size.width > 0 && size.height > 0 ? size : nil
        }
        if image, let content {
            // Shrink proportionally into the chat width and height ceiling, never enlarge.
            let scale = min(1, available / content.width, inlineImageMaxHeight / content.height)
            return CGSize(width: min(available, max(inlineImageMinSide, (content.width * scale).rounded())),
                          height: max(inlineImageMinSide, (content.height * scale).rounded()))
        }
        let width = min(available, max(inlineDefaultMaxWidth, content?.width ?? 0))
        let defaultHeight = min(720, max(360, width * 0.75))
        return CGSize(width: width, height: min(inlineMaxHeight, max(defaultHeight, content?.height ?? 0)))
    }

    public static func size(available: CGSize, contentSize: CGSize? = nil) -> CGSize {
        let baseline = CGSize(width: available.width * 0.9, height: available.height * 0.9)
        guard let contentSize, contentSize.width.isFinite, contentSize.height.isFinite,
              contentSize.width > 0, contentSize.height > 0 else { return baseline }
        // Leave a small screen margin. Include the single header in the height request.
        return CGSize(width: min(max(baseline.width, available.width - 32), max(baseline.width, contentSize.width)),
                      height: min(max(baseline.height, available.height - 32), max(baseline.height, contentSize.height + 64)))
    }
}

/// Keep viewport-relative CSS (100vh, percentages) from growing its own host indefinitely.
/// A dimension that only tracks a host resize is not a new content requirement.
public struct ArtifactContentMeasurement {
    private var previousContent: CGSize?
    private var previousViewport: CGSize?
    public private(set) var preferredSize: CGSize?

    public init() {}

    public mutating func record(content: CGSize, viewport: CGSize, intrinsicImage: Bool = false) -> CGSize? {
        guard content.width.isFinite, content.height.isFinite, content.width > 0, content.height > 0,
              viewport.width.isFinite, viewport.height.isFinite else { return preferredSize }
        func dimension(_ value: CGFloat, _ host: CGFloat, _ oldValue: CGFloat?, _ oldHost: CGFloat?, _ preferred: CGFloat?) -> CGFloat {
            guard !intrinsicImage, let oldValue, let oldHost, let preferred else { return ceil(value) }
            let contentDelta = value - oldValue
            let hostDelta = host - oldHost
            if abs(contentDelta) <= 1 && abs(hostDelta) <= 1 { return preferred }
            if abs(hostDelta) > 1 && abs(contentDelta - hostDelta) <= 1 { return preferred }
            return ceil(value)
        }
        preferredSize = CGSize(
            width: dimension(content.width, viewport.width, previousContent?.width, previousViewport?.width, preferredSize?.width),
            height: dimension(content.height, viewport.height, previousContent?.height, previousViewport?.height, preferredSize?.height))
        previousContent = content
        previousViewport = viewport
        return preferredSize
    }
}
