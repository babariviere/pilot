import Foundation

/// Expanded previews should fill most of the display, rather than use the sheet's minimum size.
public enum ArtifactViewerLayout {
    public static let inlineMaxWidth: CGFloat = 1200

    /// A roomy 4:3 viewport, bounded so narrow chats and tall previews remain usable.
    public static func inlineSize(availableWidth: CGFloat) -> CGSize {
        let width = min(inlineMaxWidth, max(0, availableWidth))
        return CGSize(width: width, height: min(720, max(360, width * 0.75)))
    }

    public static func size(available: CGSize) -> CGSize {
        CGSize(width: available.width * 0.9, height: available.height * 0.9)
    }
}
