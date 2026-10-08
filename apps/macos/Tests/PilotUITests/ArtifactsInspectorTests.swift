import Testing
@testable import Pilot

@Test @MainActor func artifactsToggleOpensTheRightInspectorAndSwitchesTabs() {
    let app = AppModel()
    #expect(!app.inspectorVisible)
    app.toggleInspector(.artifacts)
    #expect(app.inspectorVisible)
    #expect(app.inspectorTab == .artifacts)
    #expect(app.terminals.order.isEmpty)

    app.toggleInspector(.changes)
    #expect(app.inspectorVisible)
    #expect(app.inspectorTab == .changes)
    app.toggleInspector(.artifacts)
    #expect(app.inspectorVisible)
    #expect(app.inspectorTab == .artifacts)
    app.toggleInspector(.artifacts)
    #expect(!app.inspectorVisible)
    #expect(app.terminals.order.isEmpty)
}
