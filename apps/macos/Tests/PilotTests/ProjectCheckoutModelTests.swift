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
