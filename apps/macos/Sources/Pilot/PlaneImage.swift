import AppKit
import PilotCore

/// AppKit renderings of the app icon's plane, for places that cannot use the bundled .icns.
enum PlaneImage {
    // Keep image identity stable across SwiftUI menu updates, not just its pixels.
    private static let idleMenuBarImage = makeMenuBar(working: false)
    private static let workingMenuBarImage = makeMenuBar(working: true)

    /// Menu bar template image: the plane alone when idle, with a short dithered contrail while agents work.
    static func menuBar(working: Bool) -> NSImage {
        working ? workingMenuBarImage : idleMenuBarImage
    }

    /// The plane's box in the 18 pt image, toward the top right so the contrail fits behind the tail.
    /// Idle and working share it, so the plane never moves when the contrail appears.
    private static let planeBox = CGRect(x: 3.5, y: 0.5, width: 14, height: 14)
    /// The contrail: three hard squares stepping away from the tail toward the bottom left, each smaller than
    /// the last, on a half-point grid so they stay crisp on Retina displays. Flipped coordinates.
    static let contrail = [
        CGRect(x: 3, y: 13, width: 2, height: 2),
        CGRect(x: 1.5, y: 15, width: 1.5, height: 1.5),
        CGRect(x: 0.5, y: 16.5, width: 1, height: 1),
    ]

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

    private static func makeMenuBar(working: Bool) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: true) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            var transform = planeTransform
            let planePath = PlaneGlyph.path.copy(using: &transform)!
            context.setFillColor(NSColor.black.cgColor)
            context.addPath(planePath)
            context.fillPath(using: .winding)
            if working { context.fill(contrail) }
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
