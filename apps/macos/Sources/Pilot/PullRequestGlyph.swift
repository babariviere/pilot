import AppKit
import PilotCore

/// GitHub's 16 px terminal PR octicons. Open PRs keep the shared GitBranchGlyph.
/// Sources: github.com/primer/octicons, git-merge-16 and git-pull-request-closed-16 (MIT).
/// The bundled Resources/Octicons-LICENSE.txt carries the copyright and permission notice.
enum PullRequestGlyph: CaseIterable {
    case merged, closed

    var svgPath: String {
        switch self {
        case .merged:
            "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"
        case .closed:
            "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
        }
    }

    /// Vector template images, cached once like BrandMark so sidebar redraws never reparse paths.
    @MainActor var image: NSImage {
        if let cached = Self.cache[self] { return cached }
        let path = SVGPath.cgPath(svgPath)
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.scaleBy(x: rect.width / 16, y: rect.height / 16)
            context.addPath(path)
            context.setFillColor(NSColor.black.cgColor)
            context.fillPath(using: .winding)
            return true
        }
        image.isTemplate = true
        Self.cache[self] = image
        return image
    }

    @MainActor private static var cache: [PullRequestGlyph: NSImage] = [:]
}
