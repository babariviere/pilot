import AppKit

/// The familiar ten-frame braille spinner, shared by every working-status view.
enum BrailleProgress {
    static let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    static let interval = 0.1

    static func frameIndex(at date: Date) -> Int {
        let tick = Int(floor(date.timeIntervalSinceReferenceDate / interval))
        return ((tick % frames.count) + frames.count) % frames.count
    }

    /// Render real braille glyphs, preserving their typography rather than drawing
    /// a hand-spaced dot grid. Template images also work in native menu labels.
    static let images: [NSImage] = frames.map { frame in
        let glyph = NSAttributedString(string: frame, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 16, weight: .regular),
            .foregroundColor: NSColor.black,
        ])
        let image = NSImage(size: NSSize(width: 14, height: 14), flipped: false) { rect in
            let size = glyph.size()
            glyph.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2))
            return true
        }
        image.isTemplate = true
        return image
    }
}
