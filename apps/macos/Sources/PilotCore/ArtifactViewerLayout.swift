import Foundation

/// Expanded previews should fill most of the display, rather than use the sheet's minimum size.
public enum ArtifactViewerLayout {
    /// Inline artifacts stay in the chat's reading column (Theme.column), narrower with the window.
    /// Pages reflow to it and are never scaled; wider content belongs in the expanded viewer.
    public static let inlineColumnWidth: CGFloat = 760
    /// Inline HTML/React cards hug their content up to this height; taller pages scroll inside the card.
    public static let inlineMaxHeight: CGFloat = 720
    /// Keep compact HTML/React previews usable without imposing a viewport-sized floor.
    public static let inlineMinHeight: CGFloat = 48
    /// Images are scaled to fit, so a tall screenshot stays readable at a glance instead of
    /// filling several screens. The full-size image remains available in the viewer.
    public static let inlineImageMaxHeight: CGFloat = 720
    /// Keeps tiny images large enough to click without letterboxing typical ones.
    public static let inlineImageMinSide: CGFloat = 48
    /// The expanded viewer opens at 90% of the screen, but never wider than this. On ultrawide
    /// displays 90% leaves most of the sheet empty; wider content still requests more room.
    public static let viewerDefaultMaxWidth: CGFloat = 1600

    /// A bounded 4:3 fallback until measurement, then hug content height within the reading column.
    /// Native visuals grow to their full measured height and scroll with the transcript.
    /// Measured images instead hug their aspect-fitted size, so the card has no empty bands.
    public static func inlineSize(availableWidth: CGFloat, contentSize: CGSize? = nil, image: Bool = false,
                                  visual: Bool = false) -> CGSize {
        let available = availableWidth.isFinite ? min(inlineColumnWidth, max(0, availableWidth)) : inlineColumnWidth
        let content = contentSize.flatMap { size in
            size.width.isFinite && size.height.isFinite && size.width > 0 && size.height > 0 ? size : nil
        }
        if image, let content {
            // Shrink proportionally into the chat width and height ceiling, never enlarge.
            let scale = min(1, available / content.width, inlineImageMaxHeight / content.height)
            return CGSize(width: min(available, max(inlineImageMinSide, (content.width * scale).rounded())),
                          height: max(inlineImageMinSide, (content.height * scale).rounded()))
        }
        let width = available
        let defaultHeight = min(720, max(360, width * 0.75))
        let height = content.map { max(inlineMinHeight, $0.height) } ?? defaultHeight
        return CGSize(width: width, height: visual ? height : min(inlineMaxHeight, height))
    }

    /// Measured HTML/React content taller than the inline ceiling scrolls inside the card.
    /// Images and SwiftUI snapshots scale to fit instead, so they never do.
    public static func inlineScrollsInside(contentSize: CGSize?, image: Bool = false) -> Bool {
        guard !image, let height = contentSize?.height, height.isFinite else { return false }
        return height > inlineMaxHeight
    }

    public static func size(available: CGSize, contentSize: CGSize? = nil) -> CGSize {
        let baseline = CGSize(width: min(available.width * 0.9, viewerDefaultMaxWidth), height: available.height * 0.9)
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
    private var restoring = false
    private var candidate: CGSize?
    private var candidateViewport: CGSize?
    public private(set) var preferredSize: CGSize?

    public init() {}

    /// A recreated renderer starts with an empty/partially rendered DOM. Keep the lazy row's
    /// reservation until two consecutive reads agree, rather than caching its startup geometry.
    public init(retaining size: CGSize?) {
        preferredSize = size
        restoring = size != nil
    }

    public mutating func record(content: CGSize, viewport: CGSize, intrinsicImage: Bool = false) -> CGSize? {
        guard content.width.isFinite, content.height.isFinite, content.width > 0, content.height > 0,
              viewport.width.isFinite, viewport.height.isFinite,
              viewport.width > 0, viewport.height > 0 else { return preferredSize }
        if restoring {
            let settled = candidate.map { abs($0.width - content.width) <= 1 && abs($0.height - content.height) <= 1 } == true
                && candidateViewport == viewport
            candidate = content
            candidateViewport = viewport
            guard settled else { return preferredSize }
            restoring = false
            candidate = nil
            candidateViewport = nil
        }
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
