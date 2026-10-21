import Foundation
import Testing
@testable import PilotCore

@Test func offlineHostIndexSurvivesRelaunchWithPrivateWhitelistedMetadata() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let host = HostRef(hostId: "box", daemonId: "daemon", lineageId: "lineage")
    let configuration = try LegacyDevboxAddress(alias: "fixture-box")
    var session = SessionSummary(id: "same", title: "Known remote chat", cwd: "/remote/repo",
        projectId: "project", branch: "work", createdAt: 1, updatedAt: 2, state: "working",
        error: "PRIVATE_DIAGNOSTIC", outcome: .failed, outcomeAt: 1, outcomeReason: "PRIVATE_REASON",
        pinned: true, missionId: "mission", working: true)
    session.sleepPaused = true
    let project = Project(id: "project", name: "Repo", path: "/remote/repo", createdAt: 1)
    let mission = Mission(id: "mission", projectId: "project", title: "Mission", goal: "PRIVATE_CONTEXT",
                          coordinatorSessionId: "same", createdAt: 1, updatedAt: 2)
    let received = Date(timeIntervalSince1970: 100)
    let store = OfflineHostStore(directory: directory)
    try await store.save([OfflineHostSnapshot(host: host, configuration: configuration, receivedAt: received,
        sessions: [session], projects: [project], missions: [mission], stopRequests: ["same": .requested])])
    let restarted = try await OfflineHostStore(directory: directory).load()
    let saved = try #require(restarted.first)
    #expect(saved.host == host)
    #expect(saved.configuration == configuration)
    #expect(saved.receivedAt == received)
    #expect(saved.sessions.first?.state == "working")
    #expect(saved.sessions.first?.working == true)
    #expect(saved.sessions.first?.sleepPaused == true)
    #expect(saved.sessions.first?.outcome == .failed)
    #expect(saved.sessions.first?.outcomeAt == 1)
    #expect(saved.sessions.first?.pinned == true)
    #expect(saved.sessions.first?.error == nil)
    #expect(saved.sessions.first?.outcomeReason == nil)
    #expect(saved.missions.first?.coordinatorSessionId == "same")
    #expect(saved.missions.first?.goal == "")
    #expect(saved.stopRequests["same"] == .requested)
    let file = directory.appendingPathComponent("hosts.json")
    let text = try String(contentsOf: file, encoding: .utf8)
    #expect(!text.contains("PRIVATE_"))
    #expect(!text.contains("transcript"))
    #expect((try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)?.intValue == 0o700)
    #expect((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
}

@Test func offlineHostIndexDoesNotMergeCollidingIDsOrReplaceCorruptFiles() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let configuration = try LegacyDevboxAddress(alias: "fixture")
    let first = HostRef(hostId: "one", daemonId: "daemon1", lineageId: "1")
    let second = HostRef(hostId: "two", daemonId: "daemon2", lineageId: "2")
    let session = SessionSummary(id: "same", title: "Chat", cwd: "/repo", createdAt: 0, updatedAt: 0, state: "working")
    let snapshots = [first, second].map { OfflineHostSnapshot(host: $0, configuration: configuration, sessions: [session]) }
    try await OfflineHostStore(directory: directory).save(snapshots)
    let restored = try await OfflineHostStore(directory: directory).load()
    #expect(restored.count == 2)
    #expect(Set(restored.map(\.host)) == Set([first, second]))
    do {
        try await OfflineHostStore(directory: directory).save([snapshots[0], snapshots[0]])
        Issue.record("Duplicate configuration identity was accepted")
    } catch { #expect(error as? HostRoutingError == .invalidReference) }
    let file = directory.appendingPathComponent("hosts.json")
    let original = Data("{\"version\":100,\"hosts\":[]}".utf8)
    try original.write(to: file)
    let corrupt = OfflineHostStore(directory: directory)
    do { _ = try await corrupt.load(); Issue.record("Unsupported schema was accepted") } catch {}
    do { try await corrupt.save([]); Issue.record("Failed read allowed overwrite") } catch {}
    #expect(try Data(contentsOf: file) == original)
}

@Test func operationInventoryIsReadOnlyAndPinsDestinationAcrossRestart() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let origin = HostRef(hostId: "local", daemonId: "local", lineageId: "1")
    let target = HostRef(hostId: "box", daemonId: "remote", lineageId: "2")
    let outbox = OperationOutbox(directory: directory)
    let operation = try await outbox.reserve(kind: "chat-create", targetId: nil, payload: ["message": "retained draft"],
                                            origin: origin, destination: target)
    let restarted = OperationOutbox(directory: directory)
    #expect(try await restarted.pending(destination: target) == [operation])
    #expect(try await restarted.pending(destination: origin).isEmpty)
    #expect(try await restarted.pending(destination: HostRef(hostId: "box", daemonId: "remote", lineageId: "new")).isEmpty)
    #expect(try await restarted.pending() == [operation])
    #expect(try await restarted.contains(operation))
    let pending = OperationReceipt(operationId: operation.operationId, payloadHash: operation.payloadHash,
        destination: target, targetId: operation.targetId, state: .pending, result: nil, reason: nil)
    do { try await restarted.acknowledge(operation, receipt: pending); Issue.record("Pending intent was retired") }
    catch { #expect(error as? HostRoutingError == .invalidReference) }
    #expect(try await restarted.pending() == [operation])
}

@Test func offlineFlushRevisionCannotBeReplacedByAnOlderStreamingSave() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let host = HostRef(hostId: "box", daemonId: "remote", lineageId: "1")
    let configuration = try LegacyDevboxAddress(alias: "fixture")
    let current = OfflineHostSnapshot(host: host, configuration: configuration, receivedAt: Date(timeIntervalSince1970: 2))
    let old = OfflineHostSnapshot(host: host, configuration: configuration, receivedAt: Date(timeIntervalSince1970: 1))
    let store = OfflineHostStore(directory: directory)
    try await store.save([current], revision: 2)
    try await store.save([old], revision: 1)
    #expect(try await OfflineHostStore(directory: directory).load().first?.receivedAt == current.receivedAt)
}
