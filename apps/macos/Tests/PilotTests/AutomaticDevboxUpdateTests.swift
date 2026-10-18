import CryptoKit
import Foundation
import PilotCore
import Testing
@testable import Pilot

private func automaticHello(_ host: HostRef, version: String, updates: Int = 1) throws -> DaemonHello {
    let value: [String: Any] = ["daemonId": host.daemonId, "lineageId": host.lineageId, "daemonVersion": version,
        "protocolVersion": 1, "minimumClientProtocolVersion": 1, "platform": "linux", "arch": "x64",
        "capabilities": ["powerManagement": false, "systemSleepEvents": false, "swiftUIArtifacts": false,
                         "coordinatorIsolation": true, "independentExecution": true, "runtimeUpdates": updates]]
    return try JSONDecoder().decode(DaemonHello.self, from: JSONSerialization.data(withJSONObject: value))
}

private func automaticStatus(id: UUID, version: String = "1.2.3", phase: String = "waiting",
                             blockers: Bool = true, confirmed: Bool = true) throws -> RuntimeUpdateStatus {
    try JSONDecoder().decode(RuntimeUpdateStatus.self, from: Data("""
    {"id":"\(id.uuidString.lowercased())","version":"\(version)","phase":"\(phase)","requestConfirmed":\(confirmed),"revision":1,
     "blockers":\(blockers ? "[{\"kind\":\"job\",\"id\":\"job\"},{\"kind\":\"terminal\",\"id\":\"terminal\"},{\"kind\":\"transfer\",\"id\":\"transfer\"},{\"kind\":\"cleanup\",\"id\":\"cleanup\"}]" : "[]")}
    """.utf8))
}

private func automaticPackage(_ directory: URL) async throws -> LinuxRuntimePackage {
    let bytes = Data("synthetic automatic runtime".utf8), archive = directory.appendingPathComponent("runtime.tgz")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try bytes.write(to: archive)
    let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    let manifest = Data("""
    {"schemaVersion":1,"platform":"linux","arch":"x64","version":"1.2.3","tag":"v1.2.3",
    "commit":"\(String(repeating: "a", count: 40))","protocolVersion":1,"minimumClientProtocolVersion":1,
    "minimumGlibc":"2.28","minimumGlibcxx":"3.4.25","node":{"version":"24.1.0","modules":"137"},
    "archive":{"name":"Pilot-linux-x64.tar.gz","size":\(bytes.count),"sha256":"\(hash)"}}
    """.utf8)
    let key = Curve25519.Signing.PrivateKey()
    return try await LinuxRuntimePackage.verified(manifest: manifest, signature: key.signature(for: manifest),
        pinnedPublicKey: key.publicKey.rawRepresentation, releaseTag: "v1.2.3", expectedVersion: "1.2.3", archiveURL: archive)
}

@MainActor private final class AutomaticUpdateFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let host = HostRef(hostId: "box", daemonId: "box-daemon", lineageId: "box-lineage")
    lazy var store = DevboxUpdateIntentStore(directory: directory.appendingPathComponent("updates"))
    var runtimes = VerifiedRemoteRuntimes()
    var target: String? = "1.2.3"
    var versions: [HostRef: String] = [:]
    var tokens: [HostRef: HostConnectionToken] = [:]
    var statuses: [HostRef: RuntimeUpdateStatus] = [:]
    var helloReads = 0
    var packageReads = 0
    var starts: [(HostRef, UUID)] = []
    var cancels = 0
    var lookupIds: [String?] = []
    var loseStartAck = false
    var loseCancelAck = false
    var rejectPackage = false
    var holdPackage = false
    var packageRelease: CheckedContinuation<Void, Never>?
    var holdStatus = false
    var statusRelease: CheckedContinuation<Void, Never>?
    var holdStarts = false
    var startReleases: [HostRef: CheckedContinuation<Void, Never>] = [:]
    var activeStarts = 0
    var maxStarts = 0
    var package: LinuxRuntimePackage!
    var owner: AutomaticDevboxUpdates!
    var liveHosts: HostClients?

    func prepare() async throws { package = try await automaticPackage(directory); owner = makeOwner() }
    func makeOwner(store: DevboxUpdateIntentStore? = nil) -> AutomaticDevboxUpdates {
        AutomaticDevboxUpdates(runtimes: runtimes, targetVersion: { self.target }, loadPackage: { try await self.loadPackage() },
            actions: actions, store: store ?? self.store, validate: { self.tokens[$0.host] == $0 })
    }
    func loadPackage() async throws -> LinuxRuntimePackage {
        packageReads += 1
        if holdPackage { await withCheckedContinuation { packageRelease = $0 } }
        if rejectPackage { throw LinuxRuntimeManifest.ValidationError.signature }
        return package
    }
    var actions: DevboxUpdateActions {
        DevboxUpdateActions(available: { self.tokens[$0] != nil },
            configuration: { _ in try? SSHConnectionConfiguration(alias: "fixture") }, status: { id, host in
                self.lookupIds.append(id)
                if self.holdStatus {
                    self.holdStatus = false
                    await withCheckedContinuation { self.statusRelease = $0 }
                }
                guard id == nil || self.statuses[host]?.id == id else { return nil }
                return self.statuses[host]
            }, start: { _, package, host, id in
                let saved = try await self.store.current(host)
                #expect(saved?.id == id && saved?.host == host && saved?.archive == package.manifest.archive.sha256)
                self.starts.append((host, id))
                self.activeStarts += 1; self.maxStarts = max(self.maxStarts, self.activeStarts)
                defer { self.activeStarts -= 1 }
                if self.holdStarts { await withCheckedContinuation { self.startReleases[host] = $0 } }
                self.statuses[host] = try automaticStatus(id: id)
                if self.loseStartAck { throw URLError(.networkConnectionLost) }
                return id.uuidString.lowercased()
            }, cancel: { id, host in
                #expect(try await self.store.automaticSuppressed(host: host, version: "1.2.3"))
                self.cancels += 1
                if self.loseCancelAck { throw URLError(.networkConnectionLost) }
                self.statuses[host] = try automaticStatus(id: UUID(uuidString: id)!, phase: "cancelled", blockers: false)
                return try JSONDecoder().decode(RuntimeUpdateCancellation.self, from: Data("{\"id\":\"\(id)\",\"requested\":true}".utf8))
            })
    }
    func endpoint(_ host: HostRef, version: String = "1.0.0", updates: Int = 1) -> VerifiedRemoteRuntimes.Endpoint {
        let token = tokens[host] ?? HostConnectionToken(host: host)
        tokens[host] = token; versions[host] = version
        return .init(token: token, isCurrent: { self.tokens[host] == token }, hello: {
            self.helloReads += 1
            return try automaticHello(host, version: version, updates: updates)
        })
    }
    func reconnect(version: String = "1.0.0") {
        tokens[host] = HostConnectionToken(host: host)
        runtimes.update([host: endpoint(host, version: version)])
    }
    func releaseStarts() {
        holdStarts = false
        let waits = startReleases; startReleases.removeAll()
        for wait in waits.values { wait.resume() }
    }
    func close() async {
        holdPackage = false; packageRelease?.resume(); packageRelease = nil
        statusRelease?.resume(); statusRelease = nil
        releaseStarts(); owner?.stop(); runtimes.stop(); await owner?.stopAndWait()
        await liveHosts?.disconnectAll(); liveHosts = nil; owner = nil
        try? FileManager.default.removeItem(at: directory)
    }
}

@MainActor private func withAutomaticFixture(_ body: (AutomaticUpdateFixture) async throws -> Void) async throws {
    let fixture = AutomaticUpdateFixture()
    do { try await fixture.prepare(); try await body(fixture); await fixture.close() }
    catch { await fixture.close(); throw error }
}

@MainActor private func automaticUntil(_ ready: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(10)
    while !ready(), Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
    try #require(ready(), "Automatic update fixture did not settle")
}

@Suite(.serialized) struct AutomaticDevboxUpdateTests {
    @Test @MainActor func automaticPackageWaitersCancelIndependentlyAndReconnectDoesNotWaitForAbandonedIO() async throws {
        try await withAutomaticFixture { f in
            var release: CheckedContinuation<Void, Never>?
            defer { release?.resume() }
            var calls = 0
            let shared = DevboxPackageAcquisition {
                calls += 1
                await withCheckedContinuation { release = $0 }
                return f.package
            }
            let a = Task { try await shared.load() }
            let b = Task { try await shared.load() }
            try await automaticUntil { release != nil && shared.waitingCount == 2 }
            a.cancel()
            if case .failure(let error) = await a.result { #expect(error is CancellationError) }
            else { Issue.record("Cancelled package waiter succeeded") }
            #expect(calls == 1)
            release?.resume(); release = nil
            _ = try await b.value

            let cold = DevboxPackageAcquisition {
                calls += 1
                if calls == 2 { await withCheckedContinuation { release = $0 } }
                return f.package
            }
            let old = Task { try await cold.load() }
            try await automaticUntil { release != nil }
            old.cancel()
            _ = await old.result // Completes even though the injected I/O has not unwound.
            let fresh = Task { try await cold.load() }
            try await automaticUntil { cold.waitingCount == 1 }
            release?.resume(); release = nil
            _ = try await fresh.value
            #expect(calls == 3)
        }
    }

    @Test @MainActor func automaticStoreKeepsEveryCancelledTargetAndRefusesUnresolvedReplay() async throws {
        try await withAutomaticFixture { f in
            let archive = f.package.manifest.archive.sha256
            let first = try await f.store.reserve(host: f.host, version: "1.2.3", archive: archive)
            do {
                _ = try await f.store.reserve(host: f.host, version: "1.2.3", archive: archive, automatic: true)
                Issue.record("An automatic reservation replayed an unresolved request")
            } catch { #expect(error as? DevboxProblem == .savedUpdate) }
            try await f.store.suppressAutomatic(host: f.host, version: "1.2.3", updateId: first.id.uuidString)
            try await f.store.suppressAutomatic(host: f.host, version: "1.3.0", updateId: UUID().uuidString)
            let cold = DevboxUpdateIntentStore(directory: f.directory.appendingPathComponent("updates"))
            #expect(try await cold.automaticSuppressed(host: f.host, version: "1.2.3"))
            #expect(try await cold.automaticSuppressed(host: f.host, version: "1.3.0"))
            try await cold.markConclusive(host: f.host, id: first.id)
            _ = try await cold.reserve(host: f.host, version: "1.3.0", archive: archive)
            #expect(try await cold.automaticSuppressed(host: f.host, version: "1.2.3"))
            #expect(try await cold.automaticSuppressed(host: f.host, version: "1.3.0") == false)
        }
    }

    @Test @MainActor func automaticLiveStartupKeepsLocalUnblockedAndUsesTheVerifiedRuntimeOwner() async throws {
        try await withAutomaticFixture { f in
            f.holdPackage = true
            f.tokens[f.host] = HostConnectionToken(host: f.host)
            let tunnel = AutomaticUpdateTunnel()
            let hosts = HostClients(operationDirectory: f.directory.appendingPathComponent("operations"),
                makeTunnel: { _, _ in tunnel }, makeClient: {
                    let client = PilotClient(); client.loadFixture(projects: [], sessions: []); return client
                }, connectClient: { _, _ in }, automaticUpdates: .init(targetVersion: { f.target },
                    loadPackage: { try await f.loadPackage() }, actions: f.actions, store: f.store),
                readRuntimeHello: { _, host in f.helloReads += 1; return try automaticHello(host, version: "1.0.0") })
            f.liveHosts = hosts
            let offline = OfflineHostStore(directory: f.directory.appendingPathComponent("offline"))
            try await offline.save([OfflineHostSnapshot(host: f.host, configuration: SSHConnectionConfiguration(alias: "fixture"))])
            let app = AppModel(hosts: hosts)
            #expect(f.packageReads == 0 && f.helloReads == 0 && f.lookupIds.isEmpty)
            var localStarted = false
            await app.startHostConnections(offlineStore: offline) { localStarted = true }
            #expect(localStarted)
            try await automaticUntil { f.packageRelease != nil }
            #expect(f.starts.isEmpty && f.helloReads == 1)
            f.holdPackage = false; f.packageRelease?.resume(); f.packageRelease = nil
            try await automaticUntil { f.starts.count == 1 && hosts.devboxUpdates.isIdle }
            #expect(hosts.devboxUpdates.model(for: f.host).status?.phase == .waiting)
            #expect(f.helloReads == 1)
        }
    }

    @Test @MainActor func automaticOlderRuntimeStagesOnceAndSharesWaitingBlockersWithoutSettings() async throws {
        try await withAutomaticFixture { f in
            let endpoint = f.endpoint(f.host)
            f.owner.start(); f.runtimes.update([f.host: endpoint])
            try await automaticUntil { f.starts.count == 1 && f.owner.isIdle }
            let model = f.owner.model(for: f.host)
            #expect(model === f.owner.model(for: f.host))
            #expect(model.status?.phase == .waiting && model.status?.blockers.count == 4)
            #expect(DevboxUpdateCopy.title(model.status, automatic: model.automaticPhase) == "Waiting for work to finish")
            #expect(f.packageReads == 1 && f.helloReads == 1 && f.cancels == 0)
            f.runtimes.update([f.host: endpoint]); f.owner.start(); f.owner.targetChanged()
            #expect(f.starts.count == 1)
            let id = try #require(f.starts.first?.1)
            f.statuses[f.host] = try automaticStatus(id: id, phase: "completed", blockers: false)
            f.reconnect(version: "1.2.3")
            try await automaticUntil { model.automaticPhase == .current && f.owner.isIdle }
            #expect(f.starts.count == 1 && f.packageReads == 1)
        }
        // A Settings/manual check already in progress cannot consume the automatic attempt,
        // and automatic reconciliation holds the same model until request/readback settle.
        try await withAutomaticFixture { f in
            let endpoint = f.endpoint(f.host)
            let model = f.owner.model(for: f.host)
            f.holdStatus = true
            let manual = Task { await model.refresh() }
            try await automaticUntil { f.statusRelease != nil }
            f.owner.start(); f.runtimes.update([f.host: endpoint])
            try await automaticUntil { f.runtimes.isIdle && !f.owner.isIdle }
            #expect(f.starts.isEmpty && model.busy)
            f.statusRelease?.resume(); f.statusRelease = nil
            await manual.value
            try await automaticUntil { f.starts.count == 1 && f.owner.isIdle }
            #expect(model.automaticPhase == .requested && f.packageReads == 1)
        }
    }

    @Test @MainActor func automaticSameNewerUnknownAndUnsupportedVersionsNeverDownloadOrDowngrade() async throws {
        for (version, support, expected) in [("1.2.3", 1, DevboxAutomaticUpdatePhase.current),
                                            ("2.0.0", 1, .newer), ("unknown", 1, .incompatible), ("01.0.0", 1, .incompatible),
                                            ("999999999999999999999999.0.0", 1, .incompatible), ("1.0.0", 0, .incompatible)] {
            try await withAutomaticFixture { f in
                f.owner.start(); f.runtimes.update([f.host: f.endpoint(f.host, version: version, updates: support)])
                try await automaticUntil { f.owner.model(for: f.host).automaticPhase == expected && f.owner.isIdle }
                #expect(f.packageReads == 0 && f.starts.isEmpty)
            }
        }
        try await withAutomaticFixture { f in
            let endpoint = f.endpoint(f.host)
            let other = HostRef(hostId: f.host.hostId, daemonId: "wrong", lineageId: "wrong")
            f.owner.start()
            f.runtimes.update([f.host: .init(token: endpoint.token, isCurrent: endpoint.isCurrent,
                hello: { try automaticHello(other, version: "1.0.0") })])
            try await automaticUntil { f.owner.model(for: f.host).automaticPhase == .incompatible }
            #expect(f.packageReads == 0 && f.starts.isEmpty && f.lookupIds.isEmpty)
        }
    }

    @Test @MainActor func automaticLostAckAndRelaunchLookUpOriginalManualOrAutomaticIntentOnly() async throws {
        try await withAutomaticFixture { f in
            f.loseStartAck = true
            f.owner.start(); f.runtimes.update([f.host: f.endpoint(f.host)])
            try await automaticUntil { f.starts.count == 1 && f.owner.isIdle }
            let original = try #require(try await f.store.current(f.host))
            await f.owner.stopAndWait(); f.runtimes.stop()
            f.runtimes = VerifiedRemoteRuntimes()
            let reloaded = DevboxUpdateIntentStore(directory: f.directory.appendingPathComponent("updates"))
            f.owner = f.makeOwner(store: reloaded)
            f.owner.start(); f.reconnect()
            try await automaticUntil { f.owner.model(for: f.host).status?.phase == .waiting && f.owner.isIdle }
            #expect(f.starts.count == 1 && f.packageReads == 1)
            #expect(f.lookupIds.contains { $0 == original.id.uuidString.lowercased() })
            let restored = try await reloaded.current(f.host)
            #expect(restored?.id == original.id)
        }
    }

    @Test @MainActor func automaticPendingDifferentPackageAndUnknownAckCannotAllocateReplacement() async throws {
        try await withAutomaticFixture { f in
            let saved = try await f.store.reserve(host: f.host, version: "1.1.0", archive: String(repeating: "a", count: 64))
            f.owner.start(); f.runtimes.update([f.host: f.endpoint(f.host)])
            try await automaticUntil { f.owner.model(for: f.host).automaticPhase == .tracking && f.owner.isIdle }
            #expect(f.starts.isEmpty && f.packageReads == 0)
            #expect(try await f.store.current(f.host)?.id == saved.id)
        }
    }

    @Test @MainActor func automaticUnreadableStoreAndNeedsRepairFailClosedWithoutReplacingState() async throws {
        for (scenario, expected) in [("storage", DevboxAutomaticUpdatePhase.failed), ("needs-repair", .tracking),
                                     ("unknown-journal", .incompatible), ("unconfirmed", .failed)] {
            try await withAutomaticFixture { f in
                if scenario == "storage" {
                    let directory = f.directory.appendingPathComponent("updates")
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try Data("not an update index".utf8).write(to: directory.appendingPathComponent("updates.json"))
                } else {
                    f.statuses[f.host] = try automaticStatus(id: UUID(), version: scenario == "unknown-journal" ? "unknown" : "1.2.3",
                        phase: scenario == "needs-repair" ? "needs-repair" : "completed", blockers: false, confirmed: scenario != "unconfirmed")
                }
                f.owner.start(); f.runtimes.update([f.host: f.endpoint(f.host)])
                try await automaticUntil { f.owner.model(for: f.host).automaticPhase == expected && f.owner.isIdle }
                #expect(f.starts.isEmpty && f.packageReads == 0)
            }
        }
    }

    @Test @MainActor func automaticIdentityReplacementCannotPublishOldSuccessOrSendAnotherRequest() async throws {
        try await withAutomaticFixture { f in
            f.holdStarts = true
            f.owner.start(); f.runtimes.update([f.host: f.endpoint(f.host)])
            try await automaticUntil { f.startReleases.count == 1 }
            let oldModel = f.owner.model(for: f.host)
            let replacement = HostRef(hostId: f.host.hostId, daemonId: "replacement", lineageId: "replacement")
            f.tokens[f.host] = nil
            f.runtimes.update([replacement: f.endpoint(replacement)])
            f.releaseStarts()
            try await automaticUntil { f.owner.isIdle && f.owner.model(for: replacement).automaticPhase == .failed }
            #expect(oldModel.automaticPhase != .requested && oldModel.status == nil)
            #expect(f.starts.count == 1)
            let original = try await f.store.current(f.host)
            #expect(original?.conclusive == false)
        }
    }

    @Test @MainActor func automaticCancellationSurvivesLostAckReconnectAndColdLaunchUntilExplicitRetry() async throws {
        try await withAutomaticFixture { f in
            f.owner.start(); f.runtimes.update([f.host: f.endpoint(f.host)])
            try await automaticUntil { f.starts.count == 1 && f.owner.isIdle }
            let first = try #require(f.starts.first?.1)
            f.loseCancelAck = true
            await f.owner.model(for: f.host).requestCancellation()
            #expect(try await f.store.automaticSuppressed(host: f.host, version: "1.2.3"))
            f.statuses[f.host] = try automaticStatus(id: first, phase: "cancelled", blockers: false)
            await f.owner.stopAndWait(); f.runtimes.stop()
            f.runtimes = VerifiedRemoteRuntimes()
            f.owner = f.makeOwner(store: DevboxUpdateIntentStore(directory: f.directory.appendingPathComponent("updates")))
            f.owner.start(); f.reconnect()
            try await automaticUntil { f.owner.model(for: f.host).automaticPhase == .cancelled && f.owner.isIdle }
            #expect(f.starts.count == 1)
            await f.owner.model(for: f.host).request()
            #expect(f.starts.count == 2 && f.starts.last?.1 != first)
        }
    }

    @Test @MainActor func automaticTrustFailureIsBoundedAndCannotCreateAnIntent() async throws {
        try await withAutomaticFixture { f in
            f.rejectPackage = true
            let endpoint = f.endpoint(f.host)
            f.owner.start(); f.runtimes.update([f.host: endpoint])
            try await automaticUntil { f.owner.model(for: f.host).automaticPhase == .failed && f.owner.isIdle }
            f.owner.targetChanged(); f.runtimes.update([f.host: endpoint])
            #expect(f.packageReads == 1 && f.starts.isEmpty)
            #expect(try await f.store.current(f.host) == nil)
            #expect(f.owner.model(for: f.host).problem?.contains("signature") == true)
        }
    }

    @Test @MainActor func automaticDisconnectOrTargetChangeDuringDownloadCannotDispatchStalePackage() async throws {
        for changeTarget in [false, true] {
            try await withAutomaticFixture { f in
                f.holdPackage = true
                f.owner.start(); f.runtimes.update([f.host: f.endpoint(f.host)])
                try await automaticUntil { f.packageRelease != nil }
                if changeTarget { f.target = "1.3.0"; f.owner.targetChanged() }
                else { f.tokens.removeAll(); f.runtimes.update([:]) }
                f.holdPackage = false; f.packageRelease?.resume(); f.packageRelease = nil
                try await automaticUntil { f.owner.isIdle }
                #expect(f.starts.isEmpty)
                #expect(try await f.store.current(f.host) == nil)
            }
        }
    }

    @Test @MainActor func automaticWorkIsBoundedAndOneHostDoesNotBlockOthersOrInventTermination() async throws {
        try await withAutomaticFixture { f in
            let peers = (0..<3).map { HostRef(hostId: "box-\($0)", daemonId: "daemon-\($0)", lineageId: "lineage-\($0)") }
            f.holdStarts = true
            f.owner.start(); f.runtimes.update(Dictionary(uniqueKeysWithValues: peers.map { ($0, f.endpoint($0)) }))
            try await automaticUntil { f.startReleases.count == 2 }
            #expect(f.maxStarts == 2 && f.starts.count == 2)
            f.releaseStarts()
            try await automaticUntil { f.starts.count == 3 && f.owner.isIdle }
            #expect(f.maxStarts == 2 && f.cancels == 0)
            #expect(peers.allSatisfy { f.owner.model(for: $0).status?.blockers.count == 4 })
        }
    }
}

private actor AutomaticUpdateTunnel: HostTunnel {
    let url = URL(string: "http://127.0.0.1:49299")!
    func states() -> AsyncStream<SSHTunnelState> { AsyncStream { $0.yield(.connected(url)) } }
    func connect() async throws -> URL { url }
    func disconnect() async {}
}
