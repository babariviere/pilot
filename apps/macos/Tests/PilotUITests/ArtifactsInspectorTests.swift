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

@Test @MainActor func inspectorToolbarSelectionSwitchesAndClosesEveryTab() {
    let app = AppModel()
    let session = Fixtures.subagentSession
    app.client.loadFixture(projects: Fixtures.projects, sessions: [session])
    app.selectedSessionId = session.id

    for tab in [InspectorTab.changes, .terminal, .agents, .artifacts] {
        let selection = InspectorToggle.selection(for: tab, in: app)
        selection.wrappedValue = true
        #expect(app.inspectorVisible && app.inspectorTab == tab)
        #expect(selection.wrappedValue)
        selection.wrappedValue = true
        #expect(app.inspectorVisible)
        for other in [InspectorTab.changes, .terminal, .agents, .artifacts] where other != tab {
            #expect(!InspectorToggle.selection(for: other, in: app).wrappedValue)
        }
        selection.wrappedValue = false
        #expect(!app.inspectorVisible)
        #expect(!selection.wrappedValue)
        selection.wrappedValue = false
        #expect(!app.inspectorVisible)
        selection.wrappedValue = true
        #expect(app.inspectorVisible && app.inspectorTab == tab)
    }
}
