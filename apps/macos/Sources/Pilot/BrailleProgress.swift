import AppKit

/// The familiar ten-frame braille spinner, shared by every working-status view.
enum BrailleProgress {
    static let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    static let interval = 0.1

    static func frameIndex(at date: Date) -> Int {
        let tick = Int(floor(date.timeIntervalSinceReferenceDate / interval))
        return ((tick % frames.count) + frames.count) % frames.count
    }

    /// Template images work in native menu labels as well as SwiftUI rows. Drawing
    /// the Unicode braille dot pattern avoids font fallback and keeps a fixed box.
    static let images: [NSImage] = frames.map { frame in
        let pattern = Int(frame.unicodeScalars.first!.value - 0x2800)
        // Unicode dots 1–3 and 7 are on the left; 4–6 and 8 are on the right.
        let dots: [(CGFloat, CGFloat)] = [
            (4, 11.5), (4, 8.5), (4, 5.5),
            (10, 11.5), (10, 8.5), (10, 5.5),
            (4, 2.5), (10, 2.5),
        ]
        let image = NSImage(size: NSSize(width: 14, height: 14), flipped: false) { _ in
            NSColor.black.setFill()
            for (index, dot) in dots.enumerated() where pattern & (1 << index) != 0 {
                NSBezierPath(ovalIn: NSRect(x: dot.0 - 1, y: dot.1 - 1, width: 2, height: 2)).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
