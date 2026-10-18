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

    func endpoint() -> ScopedModelsSync.Endpoint {
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

@MainActor private func scopeSetup() -> (URL, ScopedModelsStore, ScopedModelsSync) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let store = ScopedModelsStore(directory: directory)
    return (directory, store, ScopedModelsSync(store: store))
}

@Test @MainActor func scopedModelsNoStartupWritesAndLocalFirstIndependentHosts() async throws {
    let (directory, store, sync) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = ScopeHostFixture("local"), remote = ScopeHostFixture("remote"), unsupported = ScopeHostFixture("unsupported")
    sync.update([local.host: local.endpoint(), remote.host: remote.endpoint()])
    await sync.start()
    try await scopeWait { sync.observations.count == 2 && sync.checking.isEmpty }
    #expect(local.writes.isEmpty && remote.writes.isEmpty)
    #expect(sync.state.desired == nil)
    var order: [String] = []
    local.onWrite = {
        let durable = try await store.load()
        #expect(durable.desired == .all && durable.revision == 1)
        #expect(durable.entry(local.host)?.attempt?.sends == 1)
        order.append("local")
    }
    remote.onWrite = { order.append("remote") }
    await sync.save(.all, joining: [local.host: local.baseline, remote.host: remote.baseline])
    try await scopeWait { sync.state.entry(remote.host)?.status == .synced && sync.checking.isEmpty }
    #expect(order == ["local", "remote"])
    #expect(local.writes.first?.0.patterns == nil)
    unsupported.failure = .unsupported
    sync.update([local.host: local.endpoint(), remote.host: remote.endpoint(), unsupported.host: unsupported.endpoint()])
    try await scopeWait { sync.state.entry(unsupported.host)?.status == .unsupported }
    #expect(sync.state.entry(remote.host)?.status == .synced)
    sync.stop()
}

@Test @MainActor func scopedModelsOfflineColdLaunchAndNewIdentityNeedExplicitConsent() async throws {
    let (directory, store, sync) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = ScopeHostFixture("remote")
    await sync.start()
    await sync.save(.init(patterns: ["desired"]), joining: [remote.host: remote.baseline])
    sync.stop()
    let restored = ScopedModelsSync(store: ScopedModelsStore(directory: directory))
    restored.update([remote.host: remote.endpoint()])
    await restored.start()
    try await scopeWait { restored.state.entry(remote.host)?.status == .synced }
    #expect(remote.writes.count == 1)
    restored.update([remote.host: remote.endpoint()])
    #expect(remote.writes.count == 1)
    let new = ScopeHostFixture("replacement")
    restored.update([new.host: new.endpoint()])
    try await scopeWait { restored.state.entry(new.host)?.observed != nil }
    #expect(new.writes.isEmpty)
    #expect(restored.state.entry(new.host)?.status == .needsConsent)
    let durable = try await store.load()
    #expect(durable.desired?.patterns == ["desired"])
    restored.stop()
}

@Test @MainActor func scopedModelsLostAckExactReadbackAndOnlyOneBoundedRetryAcrossRelaunch() async throws {
    let (directory, _, sync) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = ScopeHostFixture("remote")
    remote.loseAck = true
    sync.update([remote.host: remote.endpoint()]); await sync.start()
    try await scopeWait { sync.observations[remote.host] != nil && sync.checking.isEmpty }
    await sync.save(.all, joining: [remote.host: remote.baseline])
    try await scopeWait { sync.state.entry(remote.host)?.status == .synced }
    #expect(remote.writes.count == 1)
    remote.ignoreWrites = true
    await sync.save(.init(patterns: ["different"]), joining: [:])
    try await scopeWait { remote.writes.count == 3 && sync.checking.isEmpty }
    #expect(remote.writes.suffix(2).allSatisfy { $0.1 == "written-1" })
    sync.stop()
    let restarted = ScopedModelsSync(store: ScopedModelsStore(directory: directory))
    restarted.update([remote.host: remote.endpoint()]); await restarted.start()
    try await scopeWait { restarted.state.entry(remote.host)?.status == .failed && restarted.checking.isEmpty }
    #expect(remote.writes.count == 3)
    restarted.stop()
}

@Test @MainActor func scopedModelsConflictChoicesNeverBlindlyRebaseOtherHosts() async throws {
    let (directory, _, sync) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let a = ScopeHostFixture("a"), b = ScopeHostFixture("b")
    sync.update([a.host: a.endpoint(), b.host: b.endpoint()]); await sync.start()
    try await scopeWait { sync.observations.count == 2 && sync.checking.isEmpty }
    let baselineA = a.baseline, baselineB = b.baseline
    a.patterns = ["a-edit"]; a.hash = "a-edit"
    b.patterns = ["b-edit"]; b.hash = "b-edit"
    await sync.save(.all, joining: [a.host: baselineA, b.host: baselineB])
    try await scopeWait { sync.state.entry(a.host)?.status == .conflict && sync.state.entry(b.host)?.status == .conflict }
    #expect(a.writes.isEmpty && b.writes.isEmpty)
    await sync.useEverywhere(a.host, shown: a.baseline)
    try await scopeWait { sync.state.entry(a.host)?.status == .synced && sync.checking.isEmpty }
    #expect(sync.state.revision == 2)
    #expect(sync.state.entry(b.host)?.status == .conflict && b.writes.isEmpty)
    await sync.leave(b.host)
    b.generation = UUID(); sync.update([a.host: a.endpoint(), b.host: b.endpoint()])
    try await scopeWait { sync.checking.isEmpty }
    #expect(sync.state.entry(b.host)?.status == .divergent && b.writes.isEmpty)
    await sync.join(b.host, shown: b.baseline)
    try await scopeWait { sync.state.entry(b.host)?.status == .synced }
    #expect(b.writes.first?.1 == "b-edit")
    sync.stop()
}

@Test @MainActor func scopedModelsSupersededRevisionAndGenerationCannotPublishOldSuccess() async throws {
    let (directory, _, sync) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = ScopeHostFixture("remote")
    remote.holdWrite = true
    sync.update([remote.host: remote.endpoint()]); await sync.start()
    try await scopeWait { sync.observations[remote.host] != nil && sync.checking.isEmpty }
    await sync.save(.init(patterns: ["one"]), joining: [remote.host: remote.baseline])
    try await scopeWait { remote.held != nil }
    await sync.save(.init(patterns: ["two"]), joining: [:])
    remote.generation = UUID()
    sync.update([remote.host: remote.endpoint()])
    remote.holdWrite = false
    remote.held?.resume(); remote.held = nil
    try await scopeWait { sync.checking.isEmpty }
    #expect(sync.state.revision == 2)
    #expect(sync.state.entry(remote.host)?.appliedRevision != 2)
    #expect(sync.state.entry(remote.host)?.status == .conflict)
    #expect(remote.writes.count == 1)
    sync.stop()
}

@Test @MainActor func scopedModelsCoalescesSavesWithoutCallingOlderReadbackNewSuccess() async throws {
    let (directory, _, sync) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = ScopeHostFixture("remote")
    remote.holdWrite = true
    sync.update([remote.host: remote.endpoint()]); await sync.start()
    try await scopeWait { sync.observations[remote.host] != nil && sync.checking.isEmpty }
    await sync.save(.init(patterns: ["one"]), joining: [remote.host: remote.baseline])
    try await scopeWait { remote.held != nil }
    await sync.save(.init(patterns: ["two"]), joining: [:])
    await sync.save(.init(patterns: ["three"]), joining: [:])
    #expect(sync.state.entry(remote.host)?.appliedRevision != 3)
    remote.holdWrite = false
    remote.held?.resume(); remote.held = nil
    try await scopeWait { sync.state.entry(remote.host)?.appliedRevision == 3 && sync.checking.isEmpty }
    #expect(remote.writes.count == 2)
    #expect(remote.writes.last?.0.patterns == ["three"])
    #expect(remote.writes.last?.1 == "written-1")
    sync.stop()
}

@Test @MainActor func scopedModelsLeaveDuringAcceptedWritePersistsWithoutLateSuccessRevivingSync() async throws {
    let (directory, _, sync) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = ScopeHostFixture("remote")
    remote.holdWrite = true
    sync.update([remote.host: remote.endpoint()]); await sync.start()
    try await scopeWait { sync.observations[remote.host] != nil && sync.checking.isEmpty }
    await sync.save(.all, joining: [remote.host: remote.baseline])
    try await scopeWait { remote.held != nil }
    await sync.leave(remote.host)
    remote.holdWrite = false
    remote.held?.resume(); remote.held = nil
    try await scopeWait { sync.checking.isEmpty }
    #expect(sync.state.entry(remote.host)?.status == .divergent)
    #expect(sync.state.entry(remote.host)?.appliedRevision == nil)
    sync.stop()
    let restored = try await ScopedModelsStore(directory: directory).load()
    #expect(restored.entry(remote.host)?.status == .divergent)
}

@Test @MainActor func scopedModelsReadOnlyAndUnavailablePatternsAreTruthfulAndDurable() async throws {
    let (directory, _, sync) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = ScopeHostFixture("remote")
    remote.writable = false
    remote.unresolved = [.init(pattern: "private/model:high", matches: [], reason: "provider-not-logged-in")]
    sync.update([remote.host: remote.endpoint()]); await sync.start()
    try await scopeWait { sync.observations[remote.host] != nil && sync.checking.isEmpty }
    await sync.save(.all, joining: [remote.host: remote.baseline])
    try await scopeWait { sync.state.entry(remote.host)?.status == .readOnly && sync.checking.isEmpty }
    #expect(remote.writes.isEmpty)
    sync.stop()
    let restored = try await ScopedModelsStore(directory: directory).load()
    #expect(restored.entry(remote.host)?.unresolved == [.init(pattern: "private/model:high", reason: "provider-not-logged-in")])
    #expect(restored.entry(remote.host)?.status == .readOnly)
}

@Test @MainActor func scopedModelsBoundsIndependentHostConcurrency() async throws {
    let (directory, _, sync) = scopeSetup()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixtures = (0..<5).map { ScopeHostFixture("box-\($0)") }
    var active = 0, maximum = 0
    for fixture in fixtures {
        fixture.holdWrite = true
        fixture.onWrite = { active += 1; maximum = max(maximum, active) }
    }
    sync.update(Dictionary(uniqueKeysWithValues: fixtures.map { ($0.host, $0.endpoint()) })); await sync.start()
    try await scopeWait { sync.observations.count == 5 && sync.checking.isEmpty }
    await sync.save(.all, joining: Dictionary(uniqueKeysWithValues: fixtures.map { ($0.host, $0.baseline) }))
    try await scopeWait { fixtures.filter { $0.held != nil }.count == 2 }
    #expect(maximum == 2)
    for _ in 0..<5 {
        try await scopeWait { fixtures.contains { $0.held != nil } }
        let held = try #require(fixtures.first { $0.held != nil })
        active -= 1
        held.holdWrite = false; held.held?.resume(); held.held = nil
    }
    try await scopeWait { sync.checking.isEmpty }
    #expect(maximum == 2)
    #expect(fixtures.allSatisfy { sync.state.entry($0.host)?.status == .synced })
    sync.stop()
}
