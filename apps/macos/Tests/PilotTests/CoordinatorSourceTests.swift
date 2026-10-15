import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func coordinatorHasNoChangesOrRepositoryBadgesAndDemotionRestoresThem() async {
    let pr = SessionPullRequest(number: 42, url: "https://github.com/octo/repo/pull/42", title: "Change", state: .open, checkedAt: 1)
    func chat(coordinator: Bool) -> SessionSummary {
        SessionSummary(id: "c", title: "Plan", cwd: "/source", projectId: "p", branch: "feat/stale",
                       createdAt: 1, updatedAt: 2, state: "idle", pullRequest: pr,
                       boundPullRequests: [pr.url], missionCoordinator: coordinator)
    }
    let coordinator = chat(coordinator: true)
    let metadata = SessionRepositoryModel()
    let app = AppModel()
    app.client.loadFixture(projects: [], sessions: [coordinator])
    app.selectedSessionId = coordinator.id
    #expect(!InspectorTab.changes.isAvailable(for: coordinator))
    #expect(!InspectorTab.terminal.isAvailable(for: coordinator))
    #expect(coordinator.linkedPullRequests.isEmpty)
    #expect(coordinator.branchLinks().isEmpty)
    #expect(!coordinator.canAttachPullRequests)
    #expect(!coordinator.isBoundPullRequest(pr.url))
    #expect(!coordinator.isReadyToMerge)
    #expect(coordinator.workspaceLabel == "Read-only main view")
    app.toggleInspector(.changes)
    #expect(!app.inspectorVisible)
    await metadata.load(coordinator, client: app.client)
    await metadata.loadBranch(coordinator, client: app.client)
    #expect(metadata.summary == nil && metadata.error == nil)
    #expect(metadata.branch(for: coordinator) == nil)
    let member = chat(coordinator: false)
    app.client.loadFixture(projects: [], sessions: [member])
    #expect(InspectorTab.changes.isAvailable(for: member))
    #expect(InspectorTab.terminal.isAvailable(for: member))
    #expect(member.linkedPullRequests.count == 1)
    #expect(member.canAttachPullRequests)
    #expect(metadata.branch(for: member) == "feat/stale")
    app.toggleInspector(.changes)
    #expect(app.inspectorVisible && app.inspectorTab == .changes)
}
