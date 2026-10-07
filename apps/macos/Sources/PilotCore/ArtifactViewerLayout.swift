import Foundation

/// Expanded previews should fill most of the display, rather than use the sheet's minimum size.
public enum ArtifactViewerLayout {
    public static func size(available: CGSize) -> CGSize {
        CGSize(width: available.width * 0.9, height: available.height * 0.9)
    }
}
