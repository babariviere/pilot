import AppKit
import PilotCore

/// AppKit renderings of the app icon's plane, for places that cannot use the bundled .icns.
enum PlaneImage {
    // Keep image identity stable across SwiftUI menu updates, not just its pixels.
    private static let idleMenuBarImage = makeMenuBar(working: false)
    private static let workingMenuBarImage = makeMenuBar(working: true)

    /// Menu bar template image: the plane alone when idle, with its contrail while agents work.
    static func menuBar(working: Bool) -> NSImage {
        working ? workingMenuBarImage : idleMenuBarImage
    }

    private static func makeMenuBar(working: Bool) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            let rotate = CGAffineTransform(rotationAngle: .pi / 4)
            var plane = rotate
            let planePath = PlaneGlyph.path.copy(using: &plane)!
            var trailTransform = rotate
            let trailPath = PlaneGlyph.trail(length: 520).copy(using: &trailTransform)!
            let content = working ? planePath.boundingBoxOfPath.union(trailPath.boundingBoxOfPath) : planePath.boundingBoxOfPath
            let inset = rect.insetBy(dx: 0.5, dy: 0.5)
            let scale = min(inset.width / content.width, inset.height / content.height)
            context.translateBy(x: inset.midX, y: inset.midY)
            context.scaleBy(x: scale, y: scale)
            context.translateBy(x: -content.midX, y: -content.midY)
            context.setFillColor(NSColor.black.cgColor)
            if working {
                context.saveGState()
                context.addPath(trailPath)
                context.clip()
                let tail = CGPoint(x: 0, y: 262).applying(rotate)
                let end = CGPoint(x: 0, y: 782).applying(rotate)
                let colors = [NSColor.black.cgColor, NSColor.black.withAlphaComponent(0.1).cgColor] as CFArray
                if let gradient = CGGradient(colorsSpace: nil, colors: colors, locations: [0, 1]) {
                    context.drawLinearGradient(gradient, start: tail, end: end, options: [])
                }
                context.restoreGState()
            }
            context.addPath(planePath)
            context.fillPath()
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
