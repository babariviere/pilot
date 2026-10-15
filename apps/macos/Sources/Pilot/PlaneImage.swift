import AppKit
import PilotCore

/// AppKit renderings of the app icon's plane, for places that cannot use the bundled .icns.
enum PlaneImage {
    /// Menu bar template image: the plane, the same whether or not agents are working.
    /// Drawn once, so its identity stays stable across SwiftUI menu updates.
    static let menuBar = makeMenuBar()

    /// The plane's box in the 18 pt image.
    private static let planeBox = CGRect(x: 0.5, y: 0.5, width: 17, height: 17)

    /// Turns the glyph to head 45° to the top right and fits it in `planeBox`.
    static var planeTransform: CGAffineTransform {
        let rotate = CGAffineTransform(rotationAngle: .pi / 4)
        var turn = rotate
        let bounds = PlaneGlyph.path.copy(using: &turn)!.boundingBoxOfPath
        let scale = min(planeBox.width / bounds.width, planeBox.height / bounds.height)
        return rotate
            .concatenating(CGAffineTransform(translationX: -bounds.midX, y: -bounds.midY))
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
            .concatenating(CGAffineTransform(translationX: planeBox.midX, y: planeBox.midY))
    }

    private static func makeMenuBar() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: true) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            var transform = planeTransform
            let planePath = PlaneGlyph.path.copy(using: &transform)!
            context.setFillColor(NSColor.black.cgColor)
            context.addPath(planePath)
            context.fillPath(using: .winding)
            return true
        }
        image.isTemplate = true
        return image
    }

    /// The source tree's icon, for unbundled `swift run Pilot`. Bundled apps use CFBundleIconFile.
    static var developmentIcon: NSImage? {
        // apps/macos/Sources/Pilot/PlaneImage.swift -> apps/macos/Resources/AppIcon.icns
        let url = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Resources/AppIcon.icns")
        return NSImage(contentsOf: url)
    }
}
