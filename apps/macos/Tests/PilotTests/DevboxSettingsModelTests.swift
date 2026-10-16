import CryptoKit
import Foundation
import Testing
@testable import Pilot
@testable import PilotCore

private let settingsHost = HostRef(hostId: "box", daemonId: "daemon", lineageId: "history")

private func settingsPackage(_ directory: URL) async throws -> LinuxRuntimePackage {
    let archive = Data("synthetic signed runtime".utf8)
    let archiveURL = directory.appendingPathComponent("fixture.tgz")
    try archive.write(to: archiveURL)
    let hash = SHA256.hash(data: archive).map { String(format: "%02x", $0) }.joined()
    let manifest = Data("""
    {"schemaVersion":1,"platform":"linux","arch":"x64","version":"1.2.3","tag":"v1.2.3",
    "commit":"\(String(repeating: "a", count: 40))","protocolVersion":\(DaemonHello.clientProtocolVersion),
    "minimumClientProtocolVersion":1,"minimumGlibc":"2.28","minimumGlibcxx":"3.4.25",
    "node":{"version":"24.1.0","modules":"137"},"archive":{"name":"Pilot-linux-x64.tar.gz",
    "size":\(archive.count),"sha256":"\(hash)"}}
    """.utf8)
    let key = Curve25519.Signing.PrivateKey()
    return try await LinuxRuntimePackage.verified(manifest: manifest, signature: key.signature(for: manifest),
        pinnedPublicKey: key.publicKey.rawRepresentation, releaseTag: "v1.2.3", expectedVersion: "1.2.3", archiveURL: archiveURL)
}

private func settingsDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

@Test @MainActor func devboxSetupSavesConfirmedIdentityBeforeAdoptingItsOwnedForward() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    let package = try await settingsPackage(directory)
    var actions: [String] = []
    let configuration = try SSHConnectionConfiguration(alias: "fixture-box")
    let connection = LinuxBootstrapConnection(host: settingsHost, tunnel: ManagedSSHTunnel(configuration: configuration, validateHello: { _ in }))
    let model = DevboxSetupModel(loadPackage: { package }, actions: DevboxSetupActions(
        bootstrap: { value, _, _, pin in #expect(value == configuration); #expect(pin == nil); actions.append("bootstrap"); return connection },
        enroll: { host, value in #expect(host == settingsHost); #expect(value == configuration); actions.append("enroll") },
        adopt: { _, _ in #expect(actions.last == "enroll"); actions.append("adopt") }, dispose: { _ in actions.append("dispose") }))
    await model.prepare(alias: "fixture-box")
    #expect(model.phase == .awaitingTrust)
    #expect(actions == ["bootstrap"])
    await model.confirmEnrollment()
    #expect(actions == ["bootstrap", "enroll", "adopt"])
    #expect(model.completed == settingsHost)
    await model.cancel()
    #expect(!actions.contains("dispose"))
}

@Test @MainActor func missingTrustInvalidAliasAndFailedPinPersistenceCannotAdoptOrLeakDiagnostics() async throws {
    var touched = false
    let actions = DevboxSetupActions(bootstrap: { _, _, _, _ in touched = true; throw DevboxProblem.storage },
        enroll: { _, _ in touched = true }, adopt: { _, _ in touched = true }, dispose: { _ in touched = true })
    let missing = DevboxSetupModel(loadPackage: { throw DevboxPackageFailure.trust }, actions: actions)
    await missing.prepare(alias: "fixture-box")
    #expect(!touched)
    #expect(missing.problem?.contains("signing key") == true)
    let invalid = DevboxSetupModel(loadPackage: { throw DevboxPackageFailure.assets }, actions: actions)
    await invalid.prepare(alias: "box;send-secrets")
    #expect(!touched)
    #expect(invalid.problem?.contains("box;send-secrets") == false)
    let secret = NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "private-token-server-body"])
    #expect(!DevboxProblemText.setup(secret).contains("private-token"))
    #expect(!DevboxProblemText.update(secret).contains("private-token"))
}

@Test @MainActor func failedEnrollmentDisposesUnadoptedForwardAndKeepsObservedIdentityForExplicitRetry() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    let package = try await settingsPackage(directory)
    let configuration = try SSHConnectionConfiguration(alias: "fixture-box")
    let connection = LinuxBootstrapConnection(host: settingsHost, tunnel: ManagedSSHTunnel(configuration: configuration, validateHello: { _ in }))
    var disposed = 0, pins: [HostRef?] = [], adopted = false
    let model = DevboxSetupModel(loadPackage: { package }, actions: DevboxSetupActions(
        bootstrap: { _, _, _, pin in pins.append(pin); return connection },
        enroll: { _, _ in throw DevboxProblem.storage }, adopt: { _, _ in adopted = true }, dispose: { _ in disposed += 1 }))
    await model.prepare(alias: "fixture-box"); await model.confirmEnrollment()
    #expect(!adopted && disposed == 1)
    #expect(model.phase == .failed)
    await model.prepare(alias: "fixture-box")
    #expect(pins.count == 2 && pins[0] == nil && pins[1] == settingsHost)
    await model.cancel()
    #expect(disposed == 2)
}

@Test @MainActor func cancellingBeforePackageLoadFinishesCannotStartRemoteSetupLater() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    let package = try await settingsPackage(directory)
    var release: CheckedContinuation<LinuxRuntimePackage, Error>?, touched = false
    let model = DevboxSetupModel(loadPackage: { try await withCheckedThrowingContinuation { release = $0 } },
        actions: DevboxSetupActions(bootstrap: { _, _, _, _ in touched = true; throw DevboxProblem.storage },
            enroll: { _, _ in touched = true }, adopt: { _, _ in touched = true }, dispose: { _ in touched = true }))
    let operation = Task { await model.prepare(alias: "fixture-box") }
    for _ in 0..<100 where release == nil { await Task.yield() }
    let continuation = try #require(release)
    await model.cancel()
    continuation.resume(returning: package)
    await operation.value
    #expect(!touched && model.phase == .idle && model.candidate == nil)
}

@Test func updateIntentIsPrivateDurablePinnedAndNeverReplacesUnresolvedPackage() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    let store = DevboxUpdateIntentStore(directory: directory)
    let first = try await store.reserve(host: settingsHost, version: "1.2.3", archive: String(repeating: "a", count: 64))
    let reloaded = DevboxUpdateIntentStore(directory: directory)
    let same = try await reloaded.reserve(host: settingsHost, version: "1.2.3", archive: first.archive)
    #expect(same.id == first.id)
    do { _ = try await reloaded.reserve(host: settingsHost, version: "1.2.4", archive: first.archive); Issue.record("Must not replace an unresolved package") }
    catch { #expect(error as? DevboxProblem == .packageChanged) }
    let cloned = HostRef(hostId: settingsHost.hostId, daemonId: "different", lineageId: settingsHost.lineageId)
    do { _ = try await reloaded.reserve(host: cloned, version: first.version, archive: first.archive); Issue.record("Must not replace a pin") } catch {}
    let file = directory.appendingPathComponent("updates.json")
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    let data = try Data(contentsOf: file)
    #expect(!String(decoding: data, as: UTF8.self).contains("token"))
    try await reloaded.markConclusive(host: settingsHost, id: first.id)
    let next = try await reloaded.reserve(host: settingsHost, version: "1.2.4", archive: String(repeating: "b", count: 64))
    #expect(next.id != first.id)
}

@Test @MainActor func updatePersistsBeforeDispatchAndLostReplyOnlyRetriesSameIdAfterExplicitAction() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    let package = try await settingsPackage(directory), store = DevboxUpdateIntentStore(directory: directory.appendingPathComponent("state"))
    var available = true, calls: [UUID] = []
    let actions = DevboxUpdateActions(available: { _ in available }, configuration: { _ in try? SSHConnectionConfiguration(alias: "fixture-box") },
        status: { _, _ in nil }, start: { _, _, host, id in
            let saved = try await store.current(host)
            #expect(saved?.id == id); #expect(saved?.host == settingsHost)
            calls.append(id)
            throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "secret-SSH-diagnostic"])
        }, cancel: { _, _ in throw DevboxProblem.savedUpdate })
    let model = DevboxUpdateModel(host: settingsHost, loadPackage: { package }, actions: actions, store: store)
    await model.request()
    #expect(calls.count == 1)
    #expect(model.intent?.id == calls.first)
    #expect(model.problem?.contains("secret-SSH") == false)
    await model.refresh()
    #expect(calls.count == 1)
    await model.request()
    #expect(calls.count == 2 && calls[0] == calls[1])
    available = false; model.disconnected()
    await model.request(); await model.refresh(); await model.requestCancellation()
    #expect(calls.count == 2)
    let restarted = DevboxUpdateModel(host: settingsHost, loadPackage: { package }, actions: actions, store: DevboxUpdateIntentStore(directory: directory.appendingPathComponent("state")))
    available = true
    await restarted.refresh()
    #expect(restarted.intent?.id == calls[0])
    #expect(calls.count == 2)
}

@Test @MainActor func updateStorageFailureAndExistingActiveOwnerBlockDispatch() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    try Data("corrupt-state".utf8).write(to: directory.appendingPathComponent("updates.json"))
    var called = false
    let store = DevboxUpdateIntentStore(directory: directory)
    let actions = DevboxUpdateActions(available: { _ in true }, configuration: { _ in try? SSHConnectionConfiguration(alias: "fixture-box") },
        status: { _, _ in nil }, start: { _, _, _, _ in called = true; return "unexpected" }, cancel: { _, _ in throw DevboxProblem.savedUpdate })
    let model = DevboxUpdateModel(host: settingsHost, loadPackage: { throw DevboxPackageFailure.assets }, actions: actions, store: store)
    await model.request()
    #expect(!called)
    #expect(model.problem?.contains("No update was dispatched") == true)
    #expect(try String(contentsOf: directory.appendingPathComponent("updates.json"), encoding: .utf8) == "corrupt-state")
}

@Test @MainActor func existingRemoteUpdateBlocksNewDispatchAndCancellationRequestIsNotCancellation() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    let id = UUID().uuidString.lowercased()
    var phase = "waiting", starts = 0, cancels = 0
    let actions = DevboxUpdateActions(available: { _ in true }, configuration: { _ in try? SSHConnectionConfiguration(alias: "fixture-box") },
        status: { _, _ in try JSONDecoder().decode(RuntimeUpdateStatus.self, from: Data("""
        {"id":"\(id)","version":"1.2.3","phase":"\(phase)","requestConfirmed":true,"revision":1,
        "blockers":[{"kind":"terminal","id":"t","sessionId":"same"}]}
        """.utf8)) }, start: { _, _, _, _ in starts += 1; return id }, cancel: { value, host in
            #expect(value == id && host == settingsHost); cancels += 1
            return try JSONDecoder().decode(RuntimeUpdateCancellation.self, from: Data("{\"id\":\"\(id)\",\"requested\":true}".utf8))
        })
    let model = DevboxUpdateModel(host: settingsHost, loadPackage: { throw DevboxPackageFailure.assets }, actions: actions,
        store: DevboxUpdateIntentStore(directory: directory))
    await model.request()
    #expect(starts == 0 && model.status?.phase == .waiting)
    await model.requestCancellation()
    #expect(cancels == 1 && model.cancellationRequested)
    #expect(model.status?.phase == .waiting)
    #expect(!model.mayRetry && !model.mayFinishCancellation)
    await model.request()
    #expect(starts == 0 && model.status?.phase == .waiting)
    phase = "cancelled"
    await model.refresh()
    #expect(model.status?.phase == .cancelled)
    #expect(DevboxUpdateCopy.phase(.staged).contains("not confirmed"))
}

@Test @MainActor func preOwnerStagedCancellationCanExplicitlyRecoverOnlyItsSavedRequestWithoutInventingCancellation() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    let package = try await settingsPackage(directory)
    let store = DevboxUpdateIntentStore(directory: directory.appendingPathComponent("state"))
    let saved = try await store.reserve(host: settingsHost, version: package.manifest.version, archive: package.manifest.archive.sha256)
    let id = saved.id.uuidString.lowercased()
    var phase = "staged", retainedCancellation = false, starts: [UUID] = [], steps: [String] = []
    let actions = DevboxUpdateActions(available: { _ in true }, configuration: { _ in try? SSHConnectionConfiguration(alias: "fixture-box") },
        status: { requested, host in
            #expect(host == settingsHost)
            steps.append("status:" + (requested ?? "current"))
            return try JSONDecoder().decode(RuntimeUpdateStatus.self, from: Data("""
            {"id":"\(id)","version":"1.2.3","phase":"\(phase)","requestConfirmed":\(phase != "staged"),"revision":1,"blockers":[]}
            """.utf8))
        }, start: { _, sentPackage, host, requestID in
            #expect(host == settingsHost && requestID == saved.id)
            #expect(sentPackage.manifest.archive.sha256 == saved.archive)
            #expect(retainedCancellation)
            let persisted = try await store.current(host)
            #expect(persisted?.id == saved.id && persisted?.conclusive == false)
            steps.append("start")
            starts.append(requestID)
            return id // Owner is started, but its cancellation outcome is not yet observed.
        }, cancel: { requested, host in
            #expect(requested == id && host == settingsHost)
            retainedCancellation = true // Models the durable remote cancel record, with no owner yet.
            return try JSONDecoder().decode(RuntimeUpdateCancellation.self, from: Data("{\"id\":\"\(id)\",\"requested\":true}".utf8))
        })
    let model = DevboxUpdateModel(host: settingsHost, loadPackage: { steps.append("load"); return package }, actions: actions, store: store)
    await model.refresh(); await model.requestCancellation()
    #expect(model.cancellationRequested && model.status?.phase == .staged)
    #expect(model.mayFinishCancellation && model.mayRetry)
    #expect(starts.isEmpty)
    steps = []
    await model.request() // An explicit Finish cancelling action, never an automatic replay.
    #expect(starts == [saved.id])
    #expect(steps.prefix(4).elementsEqual(["status:current", "load", "status:" + id, "start"]))
    #expect(retainedCancellation && model.cancellationRequested)
    #expect(model.status?.phase == .staged && model.intent?.conclusive == false)
    let stillSaved = try await store.current(settingsHost)
    #expect(stillSaved?.id == saved.id && stillSaved?.archive == saved.archive && stillSaved?.conclusive == false)
    phase = "cancelled"
    await model.refresh()
    #expect(model.status?.phase == .cancelled && !model.cancellationRequested)
    #expect(model.intent?.id == saved.id && model.intent?.conclusive == true)
    #expect(starts == [saved.id] && retainedCancellation)
}

@Test @MainActor func stagedCancellationRecoveryRechecksPhaseAfterLoadingAndRefusesAnAcceptedOwner() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    let package = try await settingsPackage(directory), store = DevboxUpdateIntentStore(directory: directory.appendingPathComponent("state"))
    let saved = try await store.reserve(host: settingsHost, version: package.manifest.version, archive: package.manifest.archive.sha256)
    let id = saved.id.uuidString.lowercased()
    var phase = "staged", starts = 0
    let actions = DevboxUpdateActions(available: { _ in true }, configuration: { _ in try? SSHConnectionConfiguration(alias: "fixture-box") },
        status: { _, _ in try JSONDecoder().decode(RuntimeUpdateStatus.self, from: Data("""
        {"id":"\(id)","version":"1.2.3","phase":"\(phase)","requestConfirmed":\(phase != "staged"),"revision":1,"blockers":[]}
        """.utf8)) }, start: { _, _, _, _ in starts += 1; return id },
        cancel: { _, _ in try JSONDecoder().decode(RuntimeUpdateCancellation.self, from: Data("{\"id\":\"\(id)\",\"requested\":true}".utf8)) })
    let model = DevboxUpdateModel(host: settingsHost, loadPackage: { phase = "requested"; return package }, actions: actions, store: store)
    await model.refresh(); await model.requestCancellation()
    #expect(model.mayFinishCancellation)
    await model.request()
    #expect(starts == 0 && model.cancellationRequested)
    #expect(model.status?.phase == .requested && !model.mayRetry && !model.mayFinishCancellation)
    let persisted = try await store.current(settingsHost)
    #expect(persisted?.id == saved.id && persisted?.conclusive == false)
}

@Test @MainActor func stagedCancellationRecoveryCannotSubstituteAnotherVerifiedPackageOrMintAnotherID() async throws {
    let directory = try settingsDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
    let package = try await settingsPackage(directory), store = DevboxUpdateIntentStore(directory: directory.appendingPathComponent("state"))
    let saved = try await store.reserve(host: settingsHost, version: "1.2.2", archive: String(repeating: "a", count: 64))
    let id = saved.id.uuidString.lowercased()
    var starts = 0
    let actions = DevboxUpdateActions(available: { _ in true }, configuration: { _ in try? SSHConnectionConfiguration(alias: "fixture-box") },
        status: { _, _ in try JSONDecoder().decode(RuntimeUpdateStatus.self, from: Data("""
        {"id":"\(id)","version":"1.2.2","phase":"staged","requestConfirmed":false,"revision":1,"blockers":[]}
        """.utf8)) }, start: { _, _, _, _ in starts += 1; return id },
        cancel: { _, _ in try JSONDecoder().decode(RuntimeUpdateCancellation.self, from: Data("{\"id\":\"\(id)\",\"requested\":true}".utf8)) })
    let model = DevboxUpdateModel(host: settingsHost, loadPackage: { package }, actions: actions, store: store)
    await model.refresh(); await model.requestCancellation(); await model.request()
    #expect(starts == 0 && model.cancellationRequested && model.status?.phase == .staged)
    #expect(model.problem == DevboxProblemText.update(DevboxProblem.packageChanged))
    let persisted = try await store.current(settingsHost)
    #expect(persisted == saved)
}
