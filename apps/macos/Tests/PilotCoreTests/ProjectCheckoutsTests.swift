import Foundation
import Testing
@testable import PilotCore

private let checkoutLocal = HostRef(hostId: "local", daemonId: "mac", lineageId: "one")
private let checkoutRemote = HostRef(hostId: "box", daemonId: "linux", lineageId: "two")
private func checkout(_ id: String, host: HostRef, path: String? = nil) -> Hosted<Project> {
    Hosted(ref: HostResourceRef(host: host, kind: .project, localId: id),
           value: Project(id: id, name: "Repo", path: path ?? "/src/\(id)", createdAt: 1))
}
private func origin(_ item: Hosted<Project>, _ identity: String? = "repository") -> CheckoutOrigin {
    CheckoutOrigin(project: item.ref, path: item.value.path, identity: identity)
}

@Test func checkoutGroupsWaitForCompleteInventoryAndNeverChooseBetweenClones() throws {
    let local = checkout("local", host: checkoutLocal), box = checkout("box", host: checkoutRemote)
    let copy = checkout("worktree", host: checkoutRemote)
    let two = ProjectCheckouts.groups([local, box], origins: [origin(local), origin(box)], bindings: RepositoryBindings(), local: checkoutLocal)
    #expect(two.count == 1 && two.first?.representative.ref == local.ref)
    let partial = ProjectCheckouts.groups([local, box, copy], origins: [origin(local), origin(box)], bindings: RepositoryBindings(), local: checkoutLocal)
    #expect(partial.count == 3)
    let ambiguous = ProjectCheckouts.groups([local, box, copy], origins: [origin(local), origin(box), origin(copy)], bindings: RepositoryBindings(), local: checkoutLocal)
    #expect(ambiguous.count == 3)
    #expect(ProjectCheckouts.groups([local, box], origins: [origin(local), origin(box, nil)], bindings: RepositoryBindings(), local: checkoutLocal).count == 2)
}

@Test func explicitCheckoutChoicePinsPathsAndOriginsAndDoesNotEnableContextSharing() throws {
    let local = checkout("local", host: checkoutLocal), box = checkout("box", host: checkoutRemote)
    let facts = [origin(local), origin(box, "fork")]
    var bindings = RepositoryBindings()
    _ = try bindings.confirm(logicalProjectId: local.ref.storageKey, project: box.ref, remotePath: box.value.path,
        expectedGeneration: nil, sourcePath: local.value.path, sourceOrigin: "repository", destinationOrigin: "fork")
    #expect(ProjectCheckouts.groups([local, box], origins: facts, bindings: bindings, local: checkoutLocal).count == 1)
    #expect(ProjectCheckouts.groups([local, box], origins: [origin(local), origin(box, "changed")], bindings: bindings, local: checkoutLocal).count == 2)
    let moved = checkout("box", host: checkoutRemote, path: "/elsewhere")
    #expect(ProjectCheckouts.groups([local, moved], origins: facts, bindings: bindings, local: checkoutLocal).count == 2)
    let replaced = checkout("box", host: HostRef(hostId: "box", daemonId: "linux", lineageId: "replacement"))
    #expect(ProjectCheckouts.groups([local, replaced], origins: facts, bindings: bindings, local: checkoutLocal).count == 2)
    bindings.remove(logicalProjectId: local.ref.storageKey, host: checkoutRemote)
    #expect(bindings.mappings.isEmpty)
}

@Test func associationStoreRetainsOfflinePinsAndRejectsStaleSaves() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("checkouts.json")
    let store = RepositoryAssociationStore(file: file)
    let local = checkout("local", host: checkoutLocal), box = checkout("box", host: checkoutRemote)
    var value = RepositoryAssociations(); value.origins = [origin(local), origin(box)]
    try await store.save(value, revision: 2)
    try await store.save(RepositoryAssociations(), revision: 1)
    let loaded = try await RepositoryAssociationStore(file: file).load()
    #expect(ProjectCheckouts.groups([local, box], origins: loaded.origins, bindings: loaded.bindings, local: checkoutLocal).count == 1)
    let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
    #expect(permissions?.intValue == 0o600)
}

@Test(arguments: ["repository", "fork"])
func explicitPlacementKeepsTheSourcesAutomaticMatchesOnOtherHosts(_ destinationOrigin: String) throws {
    let a = checkout("a", host: checkoutLocal), b = checkout("b", host: checkoutRemote)
    let c = checkout("c", host: HostRef(hostId: "second-box", daemonId: "second", lineageId: "three"))
    var bindings = RepositoryBindings()
    _ = try bindings.confirm(logicalProjectId: a.ref.storageKey, project: b.ref, remotePath: b.value.path,
        expectedGeneration: nil, sourcePath: a.value.path, sourceOrigin: "repository", destinationOrigin: destinationOrigin)
    let result = ProjectCheckouts.groups([a, b, c], origins: [origin(a), origin(b, destinationOrigin), origin(c)], bindings: bindings, local: checkoutLocal)
    #expect(result.count == 1)
    #expect(Set(result.first?.checkouts.map(\.ref) ?? []) == Set([a.ref, b.ref, c.ref]))
}

@Test func explicitDestinationWinsWithoutHidingOtherHostsOrChoosingAnotherClone() throws {
    let a = checkout("a", host: checkoutLocal), b = checkout("b", host: checkoutRemote)
    let alternative = checkout("alternative", host: checkoutRemote)
    let c = checkout("c", host: HostRef(hostId: "second-box", daemonId: "second", lineageId: "three"))
    for destinationOrigin in ["repository", "fork"] {
        var bindings = RepositoryBindings()
        _ = try bindings.confirm(logicalProjectId: a.ref.storageKey, project: b.ref, remotePath: b.value.path,
            expectedGeneration: nil, sourcePath: a.value.path, sourceOrigin: "repository", destinationOrigin: destinationOrigin)
        let facts = [origin(a), origin(b, destinationOrigin), origin(alternative), origin(c)]
        for projects in [[a, b, alternative, c], [c, alternative, b, a]] {
            let result = ProjectCheckouts.groups(projects, origins: facts, bindings: bindings, local: checkoutLocal)
            let mapped = try #require(result.first { $0.checkouts.contains { $0.ref == a.ref } })
            #expect(result.count == 2)
            #expect(Set(mapped.checkouts.map(\.ref)) == Set([a.ref, b.ref, c.ref]))
            #expect(mapped.checkouts.filter { $0.ref.host == checkoutRemote }.count == 1)
        }
    }
}

@Test func overlappingExplicitPlacementsDoNotAssignAnotherHostByObservationOrder() throws {
    let a = checkout("a", host: checkoutLocal), b = checkout("b", host: checkoutRemote)
    let c = checkout("c", host: HostRef(hostId: "second-box", daemonId: "second", lineageId: "three"))
    let d = checkout("d", host: checkoutRemote)
    let e = checkout("e", host: HostRef(hostId: "third-box", daemonId: "third", lineageId: "four"))
    var bindings = RepositoryBindings()
    for (source, destination) in [(a, b), (c, d)] {
        _ = try bindings.confirm(logicalProjectId: source.ref.storageKey, project: destination.ref, remotePath: destination.value.path,
            expectedGeneration: nil, sourcePath: source.value.path, sourceOrigin: "repository", destinationOrigin: "fork")
    }
    let facts = [origin(a), origin(b, "fork"), origin(c), origin(d, "fork"), origin(e)]
    for projects in [[a, b, c, d, e], [e, d, c, b, a]] {
        let result = ProjectCheckouts.groups(projects, origins: facts, bindings: bindings, local: checkoutLocal)
        #expect(result.count == 3)
        #expect(result.contains { Set($0.checkouts.map(\.ref)) == Set([a.ref, b.ref]) })
        #expect(result.contains { Set($0.checkouts.map(\.ref)) == Set([c.ref, d.ref]) })
        #expect(result.contains { $0.checkouts.map(\.ref) == [e.ref] })
    }
}
