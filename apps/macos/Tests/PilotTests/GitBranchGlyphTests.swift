import AppKit
import Testing
@testable import Pilot

@Test @MainActor func gitBranchGlyphIsATemplateImageForNativeMenus() throws {
    let image = GitBranchGlyph.image
    #expect(image.isTemplate)
    #expect(image.size == NSSize(width: 14, height: 14))
    let bitmap = NSBitmapImageRep(cgImage: try #require(image.cgImage(forProposedRect: nil, context: nil, hints: nil)))
    var opaquePixels = 0
    var transparentPixels = 0
    for y in 0..<bitmap.pixelsHigh {
        for x in 0..<bitmap.pixelsWide {
            let alpha = try #require(bitmap.colorAt(x: x, y: y)).alphaComponent
            if alpha > 0.5 { opaquePixels += 1 }
            if alpha < 0.1 { transparentPixels += 1 }
        }
    }
    #expect(opaquePixels > 10)
    #expect(transparentPixels > 10)
}
