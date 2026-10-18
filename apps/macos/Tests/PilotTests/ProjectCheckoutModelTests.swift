import Foundation
import PilotCore
import Testing
@testable import Pilot

private let mappedLocal = HostRef(hostId: "local", daemonId: "mac", lineageId: "one")
private let mappedRemote = HostRef(hostId: "box", daemonId: "linux", lineageId: "two")
private func mappedProject(_ id: String, host: HostRef) -> Hosted<Project> {
    Hosted(ref: HostResourceRef(host: host, kind: .project, localId: id),
        value: Project(id: id, name: "Project", path: host == mappedLocal ? "/Users/test/repo" : "/home/test/repo", createdAt: 1))
}

@Test func oneProjectHomeRowRetainsBothCheckoutsActivity() {
    let local = mappedProject("local", host: mappedLocal), remote = mappedProject("remote", host: mappedRemote)
    let first = HomeProjectStatus(project: local.value, counts: ProjectDashboardCount(working: 1), readyToMerge: 0, missions: [], lastActivity: 10)
    let second = HomeProjectStatus(project: remote.value, counts: ProjectDashboardCount(needsYou: 2), readyToMerge: 1, missions: [], lastActivity: 20)
    let merged = HomeStatus.combined([first, second], representative: first)
    #expect(merged.project.id == local.value.id)
    #expect(merged.counts.working == 1 && merged.counts.needsYou == 2 && merged.readyToMerge == 1)
    #expect(merged.lastActivity == 20)
}
@MainActor private final class CheckoutReadGate {
    var result: CheckedContinuation<String?, Never>?
    var waiter: CheckedContinuation<Void, Never>?
    var began = false
    func read() async -> String? {
        await withCheckedContinuation { result = $0; began = true; waiter?.resume(); waiter = nil }
    }
    func started() async { if !began { await withCheckedContinuation { waiter = $0 } } }
    func finish() { result?.resume(returning: "repository"); result = nil }
}

@Test @MainActor func checkoutDiscoveryIsExplicitAndDiscardsHeldDisconnectedResponses() async {
    let local = mappedProject("local", host: mappedLocal), remote = mappedProject("remote", host: mappedRemote)
    let gate = CheckoutReadGate()
    let model = ProjectCheckoutModel { _ in await gate.read() }
    model.update([remote], available: [mappedRemote], generations: [mappedRemote: UUID()])
    #expect(!gate.began)
    await model.start(); await gate.started()
    model.update([local, remote], available: [], generations: [:])
    gate.finish(); await model.stop()
    #expect(model.state.origins.isEmpty)
}

@Test @MainActor func cachedCheckoutMatchSurvivesOfflineRelaunchWithoutProbingOrChangingPins() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = mappedProject("local", host: mappedLocal), remote = mappedProject("remote", host: mappedRemote)
    let store = RepositoryAssociationStore(file: directory.appendingPathComponent("checkouts.json"))
    var value = RepositoryAssociations()
    value.origins = [local, remote].map { CheckoutOrigin(project: $0.ref, path: $0.value.path, identity: "repository") }
    try await store.save(value, revision: 1)
    var reads = 0
    let model = ProjectCheckoutModel(store: store) { _ in reads += 1; return nil }
    model.update([local, remote], available: [], generations: [:])
    await model.start()
    #expect(reads == 0)
    #expect(model.groups(local: mappedLocal).count == 1)
    #expect(model.mapped(local.ref, on: mappedRemote)?.ref == remote.ref)
    await model.stop()
}

@Test @MainActor func mappedHostChoiceRoutesCheckoutWithoutChangingExistingChatOrPendingDraft() async throws {
    let local = mappedProject("local-project", host: mappedLocal), remote = mappedProject("remote-project", host: mappedRemote)
    let localClient = PilotClient(); localClient.loadFixture(projects: [local.value], sessions: [])
    localClient.handle(.missions([]))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let hosts = HostClients(operationDirectory: directory)
    let app = AppModel(client: localClient, hosts: hosts)
    try app.registerLocal(mappedLocal)
    try hosts.install(localClient, host: mappedLocal)
    let remoteClient = PilotClient(); remoteClient.loadFixture(projects: [remote.value], sessions: []); remoteClient.handle(.missions([]))
    try hosts.install(remoteClient, host: mappedRemote)
    // Explicit association works without origin/network access. It is not a shared-context binding.
    try await hosts.projectCheckouts.confirm(source: local.ref, target: remote.ref)
    app.draftProjectId = local.value.id
    app.newSessionForm.executionHost = mappedLocal
    app.newSessionForm.message = "Keep this draft"
    #expect(app.chooseNewChatHost(mappedRemote, sourceProject: local.value))
    #expect(app.draftProjectId == remote.value.id)
    #expect(app.newSessionForm.spawnRequest(in: remote.value).projectId == remote.value.id)
    #expect(app.newSessionForm.message == "Keep this draft")
    #expect(app.orderedProjects.count == 1)
    let choice = CheckoutChoice(source: local.ref, host: mappedRemote, revision: app.newSessionForm.revision)
    app.newSessionForm.checkoutChoice = choice
    #expect(app.chooseNewChatHost(mappedLocal, sourceProject: remote.value))
    app.applyCheckoutChoice(choice, target: remote)
    #expect(app.newSessionForm.executionHost == mappedLocal)
    #expect(app.draftProjectId == local.value.id)
    app.newSessionForm.pendingOperationId = "immutable-original"
    #expect(app.chooseNewChatHost(mappedRemote, independent: true))
    #expect(app.newSessionForm.pendingOperationId == nil)
    #expect(app.chooseNewChatHost(mappedLocal, independent: true))
    #expect(app.newSessionForm.pendingOperationId == "immutable-original")
}
