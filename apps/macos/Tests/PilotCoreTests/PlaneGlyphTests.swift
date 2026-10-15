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
    #expect(bounds.minX == -300 && bounds.maxX == 300)
    #expect(bounds.minY == -300 && abs(bounds.maxY - 310) < 0.01)
    // The wing roots overlap the fuselage; one winding keeps the overlap filled rather than cut out.
    #expect(PlaneGlyph.path.contains(CGPoint(x: 32, y: 0)))
    #expect(PlaneGlyph.path.contains(CGPoint(x: 0, y: 0)))
    #expect(PlaneGlyph.path.contains(CGPoint(x: 20, y: 260)))
}

@Test func svgPathsSupportRelativeCommandsSmoothCurvesAndPackedNumbers() {
    // A 10 × 10 square drawn with horizontal, vertical and relative commands.
    #expect(SVGPath.cgPath("M0 0h10v10H0z").boundingBoxOfPath == CGRect(x: 0, y: 0, width: 10, height: 10))
    // Implicit repeats after a move are lines; signs and exponents split packed numbers.
    #expect(SVGPath.parse("M0,0 5-5 1e1+0") == [
        .move(CGPoint(x: 0, y: 0)), .line(CGPoint(x: 5, y: -5)), .line(CGPoint(x: 10, y: 0)),
    ])
    // A smooth cubic reflects the previous second control point.
    #expect(SVGPath.parse("M0 0C0 1 1 1 1 0s1-1 1 0")[2] ==
        .cubic(control1: CGPoint(x: 1, y: -1), control2: CGPoint(x: 2, y: -1), to: CGPoint(x: 2, y: 0)))
}

@Test func svgArcsFollowTheSweepFlagAndPackedFlags() {
    // Two half circles of radius 5 around (5, 5); the second packs its flags ("01").
    let circle = SVGPath.cgPath("M0 5a5 5 0 0 1 10 0a5 5 0 01-10 0Z").boundingBoxOfPath
    #expect(abs(circle.minX) < 0.01 && abs(circle.minY) < 0.01)
    #expect(abs(circle.width - 10) < 0.01 && abs(circle.height - 10) < 0.01)
    // A quarter circle with sweep 1 (clockwise in the y-down SVG space) bulges toward the top right.
    let quarter = SVGPath.cgPath("M0 0A10 10 0 0 1 10 10Z")
    #expect(quarter.contains(CGPoint(x: 6, y: 3)))
    #expect(!quarter.contains(CGPoint(x: 3, y: 6)))
    let counter = SVGPath.cgPath("M0 0A10 10 0 0 0 10 10Z")
    #expect(counter.contains(CGPoint(x: 3, y: 6)))
    // Elliptical radii scale the arc: a half ellipse 20 wide and 5 tall.
    let ellipse = SVGPath.cgPath("M0 5A10 5 0 0 1 20 5Z").boundingBoxOfPath
    #expect(abs(ellipse.minY) < 0.01 && abs(ellipse.width - 20) < 0.01)
}
