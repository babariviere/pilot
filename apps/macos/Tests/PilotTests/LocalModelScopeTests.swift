import Foundation
import PilotCore
import Testing
@testable import Pilot

@MainActor private final class ScopeHostFixture {
    let host: HostRef
    var generation = UUID()
    var patterns: [String]? = ["old"]
    var hash = "old-hash"
    var reads = 0
    var writes: [(ScopedModelsSelection, String)] = []
    var failure: ScopedModelsFailure?
    var loseAck = false
    var ignoreWrites = false
    var held: CheckedContinuation<Void, Never>?
    var holdWrite = false
    var writable = true
    var unresolved: [ScopedModelsObservation.Resolution] = []
    var onWrite: (() async throws -> Void)?

    init(_ id: String) { host = HostRef(hostId: id, daemonId: "daemon-" + id, lineageId: "lineage-" + id) }
    var baseline: ScopedModelsBaseline { .init(patterns: patterns, hash: hash) }

    func endpoint() -> LocalModelScope.Endpoint {
        let token = HostConnectionToken(host: host, generation: generation)
        return .init(token: token, read: {
            self.reads += 1
            if let failure = self.failure { throw failure }
            return ScopedModelsObservation(baseline: self.baseline, resolution: self.unresolved, writable: self.writable)
        }, write: { selection, expectedHash in
            self.writes.append((selection, expectedHash))
            try await self.onWrite?()
            if self.holdWrite { await withCheckedContinuation { self.held = $0 } }
            if let failure = self.failure { throw failure }
            if selection.patterns != self.patterns && expectedHash != self.hash { throw ScopedModelsFailure.conflict }
            if !self.ignoreWrites { self.patterns = selection.patterns; self.hash = "written-\(self.writes.count)" }
            if self.loseAck { throw ScopedModelsFailure.unavailable }
        }, isCurrent: { self.generation == token.generation })
    }
}

@MainActor private func scopeWait(_ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(10)
    while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
    try #require(condition(), "Scoped models fixture did not settle")
}

@MainActor private func scopeSetup() -> (URL, ScopedModelsStore, LocalModelScope) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let store = ScopedModelsStore(directory: directory)
    return (directory, store, LocalModelScope(store: store))
}

@Test @MainActor func localModelScopePersistsIntentBeforeItsOnlyWriteAndRejectsRemoteEndpoints() async throws {
    let (directory, store, scope) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = ScopeHostFixture("local"), remote = ScopeHostFixture("remote")
    scope.update(remote.endpoint()); await scope.start()
    #expect(remote.reads == 0 && remote.writes.isEmpty)
    scope.update(local.endpoint())
    try await scopeWait { scope.observations[local.host] != nil && scope.isIdle }
    #expect(local.writes.isEmpty)
    local.onWrite = {
        let saved = try await store.load()
        #expect(saved.desired == .all && saved.entry(local.host)?.attempt?.sends == 1)
    }
    await scope.save(.all, on: local.host, baseline: local.baseline)
    try await scopeWait { scope.state.entry(local.host)?.status == .synced && scope.isIdle }
    #expect(local.writes.count == 1 && remote.writes.isEmpty)
    await scope.stopAndWait()
}

@Test @MainActor func localModelScopeLostAckUsesExactReadbackAndKeepsRetryBudgetAcrossRelaunch() async throws {
    let (directory, _, scope) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = ScopeHostFixture("local")
    local.loseAck = true
    scope.update(local.endpoint()); await scope.start()
    try await scopeWait { scope.observations[local.host] != nil && scope.isIdle }
    await scope.save(.all, on: local.host, baseline: local.baseline)
    try await scopeWait { scope.state.entry(local.host)?.status == .synced && scope.isIdle }
    #expect(local.writes.count == 1)
    local.ignoreWrites = true
    await scope.save(.init(patterns: ["later"]), on: local.host)
    try await scopeWait { local.writes.count == 3 && scope.isIdle }
    await scope.stopAndWait()
    let restored = LocalModelScope(store: ScopedModelsStore(directory: directory))
    restored.update(local.endpoint()); await restored.start()
    try await scopeWait { restored.isIdle }
    #expect(local.writes.count == 3 && restored.state.entry(local.host)?.status == .failed)
    await restored.stopAndWait()
}

@Test @MainActor func localModelScopeConflictAndLeaveCannotBeOverwrittenByAnotherSave() async throws {
    let (directory, _, scope) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = ScopeHostFixture("local")
    scope.update(local.endpoint()); await scope.start()
    try await scopeWait { scope.observations[local.host] != nil && scope.isIdle }
    let baseline = local.baseline
    local.hash = "external-change"; local.patterns = ["external"]
    await scope.save(.all, on: local.host, baseline: baseline)
    try await scopeWait { scope.state.entry(local.host)?.status == .conflict && scope.isIdle }
    #expect(local.writes.isEmpty)
    await scope.save(.init(patterns: ["new-intent"]), on: local.host)
    try await scopeWait { scope.isIdle }
    #expect(local.writes.isEmpty && scope.state.entry(local.host)?.status == .conflict)
    await scope.leave(local.host)
    await scope.save(.all, on: local.host)
    try await scopeWait { scope.isIdle }
    #expect(local.writes.isEmpty && scope.state.entry(local.host)?.status == .divergent)
    await scope.stopAndWait()
}

@Test @MainActor func localModelScopeReplacementWaitsForOldWriteWithoutPublishingStaleSuccess() async throws {
    let (directory, _, scope) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = ScopeHostFixture("local")
    scope.update(local.endpoint()); await scope.start()
    try await scopeWait { scope.observations[local.host] != nil && scope.isIdle }
    local.holdWrite = true
    await scope.save(.init(patterns: ["first"]), on: local.host, baseline: local.baseline)
    try await scopeWait { local.held != nil }
    local.generation = UUID(); scope.update(local.endpoint())
    let writes = local.writes.count
    await Task.yield()
    #expect(local.writes.count == writes && !scope.isIdle)
    local.holdWrite = false
    let release = local.held; local.held = nil; release?.resume()
    try await scopeWait { scope.isIdle }
    #expect(scope.state.entry(local.host)?.status == .synced)
    #expect(local.writes.count == 1)
    await scope.stopAndWait()
}

@Test @MainActor func localModelScopeSupersededSavesApplyOnlyTheLatestPendingSelection() async throws {
    let (directory, _, scope) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = ScopeHostFixture("local")
    scope.update(local.endpoint()); await scope.start()
    try await scopeWait { scope.observations[local.host] != nil && scope.isIdle }
    local.holdWrite = true
    await scope.save(.init(patterns: ["first"]), on: local.host, baseline: local.baseline)
    try await scopeWait { local.held != nil }
    await scope.save(.init(patterns: ["second"]), on: local.host)
    await scope.save(.init(patterns: ["last"]), on: local.host)
    local.holdWrite = false
    let release = local.held; local.held = nil; release?.resume()
    try await scopeWait { scope.isIdle }
    #expect(local.writes.map { $0.0.patterns } == [["first"], ["last"]])
    #expect(scope.state.entry(local.host)?.appliedRevision == 3)
    await scope.stopAndWait()
}
