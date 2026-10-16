import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func coordinatorMissionInspectorActionOpensOverviewWithoutChangingInspectorState() {
    let app = AppModel()
    let coordinator = missionNavigationChat(coordinator: true)
    app.client.loadFixture(projects: [], sessions: [coordinator])
    app.selectedSessionId = coordinator.id
    app.missionTab = .tasks
    // A mission panel left open in a member chat must not appear in the coordinator.
    app.inspectorVisible = true
    app.inspectorTab = .mission
    #expect(!InspectorTab.mission.isAvailable(for: coordinator))

    app.toggleInspector(.mission)

    #expect(app.selectedSessionId == nil)
    #expect(app.selectedMissionId == "mission")
    #expect(app.missionTab == .overview)
    #expect(app.inspectorVisible)
    #expect(app.inspectorTab == .mission)
    #expect(app.terminals.order.isEmpty)
}

@Test @MainActor func memberMissionInspectorBindingStillSwitchesAndClosesTaskInspector() {
    let app = AppModel()
    let member = missionNavigationChat(coordinator: false)
    app.client.loadFixture(projects: [], sessions: [member])
    app.selectedSessionId = member.id
    app.inspectorVisible = true
    app.inspectorTab = .artifacts
    #expect(InspectorTab.mission.isAvailable(for: member))

    let selection = InspectorToggle.selection(for: .mission, in: app)
    selection.wrappedValue = true
    #expect(app.inspectorVisible && app.inspectorTab == .mission)
    #expect(app.selectedSessionId == member.id)
    #expect(app.selectedMissionId == nil)
    selection.wrappedValue = true
    #expect(app.inspectorVisible)
    selection.wrappedValue = false
    #expect(!app.inspectorVisible)
    #expect(app.selectedSessionId == member.id)
}

@Test @MainActor func detachedCoordinatorHasNoMissionControlDestination() {
    let app = AppModel()
    let detached = missionNavigationChat(coordinator: true, missionId: nil)
    app.client.loadFixture(projects: [], sessions: [detached])
    app.selectedSessionId = detached.id
    #expect(!InspectorTab.mission.isAvailable(for: detached))

    app.toggleInspector(.mission)

    #expect(app.selectedSessionId == detached.id)
    #expect(app.selectedMissionId == nil)
    #expect(!app.inspectorVisible)
}

private func missionNavigationChat(coordinator: Bool, missionId: String? = "mission") -> SessionSummary {
    SessionSummary(id: "chat", title: "Plan", cwd: "/source", createdAt: 1, updatedAt: 2,
                   state: "idle", missionId: missionId, missionCoordinator: coordinator,
                   activeMissionCoordinator: false)
}
