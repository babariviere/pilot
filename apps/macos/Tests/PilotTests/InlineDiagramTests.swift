import Foundation
import Testing
@testable import Pilot

@Test @MainActor func inlineDiagramStartsWithPreviewAndWaitsUntilVisible() {
    let state = InlineDiagramViewState()
    #expect(!state.source)
    #expect(!state.visible)
    state.source.toggle()
    #expect(state.source)
}

@Test @MainActor func inlineDiagramHeightFitsContentAndCapsLargeDiagrams() {
    let layout = InlineDiagramLayout()
    layout.update(320.2)
    #expect(layout.height == 321)
    layout.update(2000)
    #expect(layout.height == 480)
    layout.update(0)
    #expect(layout.height == 60)
    layout.update(.infinity)
    layout.update(.nan)
    #expect(layout.height == 60)
}

@Test @MainActor func inlineDiagramFitsTallDrawingsAndResizesFromTheirNaturalSize() {
    let layout = InlineDiagramLayout()
    // Not laid out yet: the natural size waits for a width.
    layout.update(natural: CGSize(width: 640, height: 320), width: 0)
    #expect(layout.height == 180)
    #expect(layout.resize(width: 760))
    #expect(layout.height == 344)
    #expect(layout.resize(width: 320))
    #expect(layout.height == 172)
    // A tall drawing scales into the 480 pt block rather than being cut off.
    layout.update(natural: CGSize(width: 400, height: 3000), width: 760)
    #expect(layout.height == 480)
    #expect(!InlineDiagramLayout().resize(width: 760))
}
