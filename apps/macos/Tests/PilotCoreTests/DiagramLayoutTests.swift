import CoreGraphics
import Foundation
import Testing
@testable import PilotCore

@Test func diagramsKeepTheirNaturalSizeWhenTheyFit() {
    #expect(DiagramLayout.fit(CGSize(width: 300, height: 200), within: CGSize(width: 736, height: 456)) == CGSize(width: 300, height: 200))
    // Never enlarge a small drawing, even in a large viewer.
    #expect(DiagramLayout.fit(CGSize(width: 40, height: 20), within: CGSize(width: 4000, height: 4000)) == CGSize(width: 40, height: 20))
}

@Test func wideAndTallDiagramsShrinkUniformlyToTheirBounds() throws {
    let wide = try #require(DiagramLayout.fit(CGSize(width: 1472, height: 400), within: CGSize(width: 736, height: 456)))
    #expect(wide == CGSize(width: 736, height: 200))
    let tall = try #require(DiagramLayout.fit(CGSize(width: 400, height: 1824), within: CGSize(width: 736, height: 456)))
    #expect(tall == CGSize(width: 100, height: 456))
    // Both limits apply; the tighter one wins and the aspect ratio holds.
    let both = try #require(DiagramLayout.fit(CGSize(width: 2000, height: 2000), within: CGSize(width: 736, height: 456)))
    #expect(both == CGSize(width: 456, height: 456))
}

@Test func unusableDiagramSizesAreRejected() {
    for size in [CGSize.zero, CGSize(width: -1, height: 10), CGSize(width: CGFloat.nan, height: 10), CGSize(width: 10, height: CGFloat.infinity)] {
        #expect(DiagramLayout.fit(size, within: CGSize(width: 100, height: 100)) == nil)
        #expect(DiagramLayout.inlineHeight(natural: size, availableWidth: 760) == nil)
    }
    #expect(DiagramLayout.inlineHeight(natural: CGSize(width: 10, height: 10), availableWidth: 0) == nil)
    #expect(DiagramLayout.inlineHeight(natural: CGSize(width: 10, height: 10), availableWidth: .nan) == nil)
}

@Test func inlineDiagramHeightIncludesPaddingAndStaysWithinTheCeiling() {
    // 760 pt column: 736 pt drawing width and 456 pt drawing height after 12 pt padding.
    #expect(DiagramLayout.inlineDrawingMaxHeight == 456)
    #expect(DiagramLayout.inlineHeight(natural: CGSize(width: 640, height: 320), availableWidth: 760) == 344)
    // Tall diagrams scale to fit 480 pt instead of being clipped.
    #expect(DiagramLayout.inlineHeight(natural: CGSize(width: 400, height: 3000), availableWidth: 760) == 480)
    #expect(DiagramLayout.inlineDrawingSize(natural: CGSize(width: 400, height: 3000), availableWidth: 760)
            == CGSize(width: 60.8, height: 456))
    // Narrower columns shrink a wide drawing, and with it the row.
    #expect(DiagramLayout.inlineHeight(natural: CGSize(width: 640, height: 320), availableWidth: 320) == 172)
    // A tiny drawing keeps a clickable block.
    #expect(DiagramLayout.inlineHeight(natural: CGSize(width: 20, height: 4), availableWidth: 760) == 60)
    // Fractional drawing heights round up, so the image is never cut by a pixel.
    #expect(DiagramLayout.inlineHeight(natural: CGSize(width: 100, height: 100.2), availableWidth: 760) == 125)
}

@Test func measuredDiagramHeightsAreClampedToTheInlineBounds() {
    #expect(DiagramLayout.inlineHeight(measured: 320.2) == 321)
    #expect(DiagramLayout.inlineHeight(measured: 2000) == 480)
    #expect(DiagramLayout.inlineHeight(measured: 0) == 60)
    #expect(DiagramLayout.inlineHeight(measured: .nan) == nil)
    #expect(DiagramLayout.inlineHeight(measured: .infinity) == nil)
}

@Test func measuredSizeMemoryEvictsTheOldestAndRefreshesRecency() {
    var memory = MeasuredSizeMemory(limit: 2)
    let storedA = memory.store(CGSize(width: 1, height: 1), for: "a")
    let storedB = memory.store(CGSize(width: 2, height: 2), for: "b")
    #expect(storedA && storedB)
    // Storing "a" again makes it the newest without changing its value.
    let restoredA = memory.store(CGSize(width: 1, height: 1), for: "a")
    #expect(!restoredA)
    let storedC = memory.store(CGSize(width: 3, height: 3), for: "c")
    #expect(storedC)
    #expect(memory.count == 2)
    #expect(memory["b"] == nil)
    #expect(memory["a"] == CGSize(width: 1, height: 1))
    #expect(memory["c"] == CGSize(width: 3, height: 3))
    let changedA = memory.store(CGSize(width: 4, height: 5), for: "a")
    #expect(changedA)
    #expect(memory.entries.map(\.key) == ["c", "a"])
}

@Test func measuredSizeMemoryIgnoresInvalidSizesAndRestoresPersistedEntries() throws {
    var memory = MeasuredSizeMemory(limit: 3)
    let zero = memory.store(CGSize(width: 0, height: 10), for: "zero")
    let nan = memory.store(CGSize(width: CGFloat.nan, height: 10), for: "nan")
    let unnamed = memory.store(CGSize(width: 10, height: 10), for: "")
    #expect(!zero && !nan && !unnamed)
    #expect(memory.count == 0)
    for (index, key) in ["a", "b", "c", "d"].enumerated() {
        memory.store(CGSize(width: 100 + index, height: 50), for: key)
    }
    let data = try JSONEncoder().encode(memory.entries)
    let saved = try JSONDecoder().decode([MeasuredSizeMemory.Entry].self, from: data)
    let restored = MeasuredSizeMemory(limit: 3, entries: saved)
    #expect(restored == memory)
    // A smaller limit keeps the newest entries; corrupt entries are skipped.
    let bounded = MeasuredSizeMemory(limit: 2, entries: saved + [.init(key: "bad", width: -1, height: 4)])
    #expect(bounded.entries.map(\.key) == ["c", "d"])
}
