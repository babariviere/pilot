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
