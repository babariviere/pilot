import CoreGraphics
import Foundation
import Testing
@testable import PilotCore

@Test func parsesAbsoluteSVGPathCommands() {
    #expect(SVGPath.parse("M 0 -1 L 2,3 4 5 Q 1 1 2 2 C 1 2 3 4 5 6 Z") == [
        .move(CGPoint(x: 0, y: -1)),
        .line(CGPoint(x: 2, y: 3)),
        .line(CGPoint(x: 4, y: 5)),
        .quad(control: CGPoint(x: 1, y: 1), to: CGPoint(x: 2, y: 2)),
        .cubic(control1: CGPoint(x: 1, y: 2), control2: CGPoint(x: 3, y: 4), to: CGPoint(x: 5, y: 6)),
        .close,
    ])
}

@Test func planeGlyphMatchesTheAppIcon() throws {
    // Tests/PilotCoreTests/PlaneGlyphTests.swift -> Resources/AppIcon.svg
    let svg = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appending(path: "Resources/AppIcon.svg")
    let source = try String(contentsOf: svg, encoding: .utf8)
    #expect(source.contains("<path id=\"plane\" d=\"\(PlaneGlyph.svgPath)\"/>"))
    let bounds = PlaneGlyph.path.boundingBoxOfPath
    #expect(bounds.minX == -290 && bounds.maxX == 290)
    #expect(bounds.minY == -300 && bounds.maxY > 250)
}
