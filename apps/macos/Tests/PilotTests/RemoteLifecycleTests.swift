import Foundation
import PilotCore
import Testing
@testable import Pilot

private actor LifecycleTunnel: HostTunnel {
    private let stream: AsyncStream<SSHTunnelState>
    private let continuation: AsyncStream<SSHTunnelState>.Continuation
    private let url: URL
    private let waitForCleanup: Bool
    private var cleanup: CheckedContinuation<Void, Never>?
    private(set) var disconnects = 0
    init(url: URL, waitForCleanup: Bool = false) {
        self.url = url; self.waitForCleanup = waitForCleanup
        let pair = AsyncStream<SSHTunnelState>.makeStream(bufferingPolicy: .bufferingNewest(1))
        stream = pair.stream; continuation = pair.continuation
        continuation.yield(.disconnected)
    }
    func states() -> AsyncStream<SSHTunnelState> { stream }
    func connect() -> URL { continuation.yield(.connected(url)); return url }
    func emit(_ state: SSHTunnelState) { continuation.yield(state) }
    func disconnect() async {
        disconnects += 1
        if waitForCleanup { await withCheckedContinuation { cleanup = $0 } }
        continuation.yield(.disconnected)
    }
    func finishCleanup() { cleanup?.resume(); cleanup = nil }
}

@MainActor private func lifecycleEventually(_ predicate: () async -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !(await predicate()) {
        guard ContinuousClock.now < deadline else { throw ClientError("Lifecycle fixture timed out") }
        try await Task.sleep(for: .milliseconds(5))
    }
}

@MainActor private func lifecycleClient(title: String = "Remote", state: String = "working") -> PilotClient {
    let client = PilotClient()
    client.loadFixture(projects: [Project(id: "p", name: "Repo", path: "/remote/repo", createdAt: 0)], sessions: [
        SessionSummary(id: "same", title: title, cwd: "/remote/repo", createdAt: 0, updatedAt: 0, state: state),
    ])
    return client
}

@Test @MainActor func remoteSummariesAndPinsSurviveOfflineAppRestartWithoutOutcomesOrNetwork() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = HostRef(hostId: "box", daemonId: "remote", lineageId: "r1")
    let local = HostRef(hostId: "local", daemonId: "local", lineageId: "l1")
    let store = OfflineHostStore(directory: directory.appendingPathComponent("hosts"))
    let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
    try await hosts.restoreOffline(from: store)
    try await hosts.enroll(remote, configuration: SSHConnectionConfiguration(alias: "fixture-box"))
    let client = lifecycleClient()
    try hosts.install(client, host: remote)
    await hosts.disconnect(remote)
    try await hosts.flushOffline()

    var attemptedConnection = false
    let restarted = HostClients(operationDirectory: directory.appendingPathComponent("operations"), makeTunnel: { _, _ in
        attemptedConnection = true
        return LifecycleTunnel(url: URL(string: "http://127.0.0.1:49999")!)
    })
    try await restarted.restoreOffline(from: OfflineHostStore(directory: directory.appendingPathComponent("hosts")))
    #expect(!attemptedConnection)
    #expect(restarted.available.isEmpty)
    let ref = HostResourceRef(host: remote, kind: .session, localId: "same")
    #expect(restarted.sessions.first?.ref == ref)
    #expect(restarted.sessions.first?.value.state == "working")
    #expect(restarted.sessions.first?.value.outcome == nil)
    #expect(restarted.connectionStates[remote] == .disconnected)
    #expect(restarted.historyAvailability(ref, cached: false) == .requiresReconnect)
    #expect(restarted.historyAvailability(ref, cached: false).explanation?.contains("Reconnect") == true)
    #expect(restarted.historyAvailability(ref, cached: true) == .cached)
    let localClient = lifecycleClient(title: "Local", state: "idle")
    try restarted.install(localClient, host: local)
    #expect(restarted.sessions.count == 2)
    #expect(restarted.sessions.first { $0.ref == ref }?.value.state == "working")
    #expect(throws: HostRoutingError.disconnected) { try restarted.endpoint(ref, kind: .session) }
    do {
        try await restarted.enroll(HostRef(hostId: "box", daemonId: "remote", lineageId: "restored"),
                                   configuration: SSHConnectionConfiguration(alias: "fixture-box"))
        Issue.record("Re-paired a changed storage lineage")
    } catch { #expect(error as? HostRoutingError == .identityChanged) }
}

@Test @MainActor func tunnelStateDropsFenceOldClientsAndRebuildOnlyThePinnedPartition() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = HostRef(hostId: "box", daemonId: "remote", lineageId: "r1")
    let local = HostRef(hostId: "local", daemonId: "local", lineageId: "l1")
    let firstURL = URL(string: "http://127.0.0.1:49001")!
    let secondURL = URL(string: "http://127.0.0.1:49002")!
    let tunnel = LifecycleTunnel(url: firstURL)
    var clients: [PilotClient] = []
    var urls: [URL] = []
    let hosts = HostClients(operationDirectory: directory, makeTunnel: { _, host in
        #expect(host == remote)
        return tunnel
    }, makeClient: {
        let client = lifecycleClient()
        clients.append(client)
        return client
    }, connectClient: { _, url in urls.append(url) })
    let localClient = lifecycleClient(title: "Local")
    try hosts.install(localClient, host: local)
    try await hosts.restoreOffline(from: OfflineHostStore(directory: directory.appendingPathComponent("hosts")))
    try await hosts.enroll(remote, configuration: SSHConnectionConfiguration(alias: "fixture-box"))
    try await hosts.connect(host: remote, configuration: SSHConnectionConfiguration(alias: "fixture-box"))
    try await lifecycleEventually { hosts.available.contains(remote) }
    let old = try hosts.endpoint(remote)
    var remoteSummaryEvents = 0
    old.onSessionsChanged = { _, _ in remoteSummaryEvents += 1 }
    let fence = try hosts.token(for: remote)
    let ref = HostResourceRef(host: remote, kind: .session, localId: "same")
    var deliveries = 0
    let unsubscribe = try hosts.subscribe(ref) { _ in deliveries += 1 }
    old.handle(.events(sessionId: "same", events: [.string("first")], seq: nil))
    #expect(deliveries == 1)
    await tunnel.emit(.connecting(attempt: 2))
    try await lifecycleEventually { !hosts.available.contains(remote) }
    #expect(!old.connected)
    #expect(hosts.sessions.first { $0.ref == ref }?.value.state == "working")
    #expect(hosts.sessions.first { $0.ref == ref }?.value.outcome == nil)
    #expect(localClient.connected)
    var pausedLocal = try #require(localClient.session("same"))
    pausedLocal.sleepPaused = true
    localClient.handle(.session(pausedLocal))
    #expect(hosts.sessions.first { $0.ref == ref }?.value.sleepPaused != true)
    #expect(remoteSummaryEvents == 0, "A local sleep hold or transport drop must not fabricate a remote outcome event")
    old.handle(.events(sessionId: "same", events: [.string("stale")], seq: nil))
    #expect(deliveries == 1)
    await tunnel.emit(.connected(secondURL))
    try await lifecycleEventually { hosts.available.contains(remote) }
    let replacement = try hosts.endpoint(remote)
    #expect(replacement !== old)
    #expect(replacement.hostIdentity == remote)
    #expect(urls.last == secondURL)
    #expect(throws: HostRoutingError.staleGeneration) { try hosts.validate(fence) }
    replacement.handle(.events(sessionId: "same", events: [.string("fresh")], seq: nil))
    #expect(deliveries == 2)
    unsubscribe()
    await tunnel.emit(.failed(.rejectedHello))
    try await lifecycleEventually { !hosts.available.contains(remote) }
    #expect(hosts.sessions.first { $0.ref == ref }?.value.state == "working")
    #expect(hosts.available.contains(local))
    #expect(clients.count == 2)
    await hosts.disconnect(remote)
}

@Test @MainActor func ordinaryQuitWaitsForOnlyOwnedLocalForwardsAndNeverStopsLocalOrRemoteAgents() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = HostRef(hostId: "box", daemonId: "remote", lineageId: "r1")
    let local = HostRef(hostId: "local", daemonId: "local", lineageId: "l1")
    let tunnel = LifecycleTunnel(url: URL(string: "http://127.0.0.1:49003")!, waitForCleanup: true)
    let hosts = HostClients(operationDirectory: directory, makeTunnel: { _, _ in tunnel },
                            makeClient: { lifecycleClient() }, connectClient: { _, _ in })
    let localClient = lifecycleClient(title: "Local")
    try hosts.install(localClient, host: local)
    try await hosts.restoreOffline(from: OfflineHostStore(directory: directory.appendingPathComponent("hosts")))
    try await hosts.enroll(remote, configuration: SSHConnectionConfiguration(alias: "fixture-box"))
    try await hosts.connect(host: remote, configuration: SSHConnectionConfiguration(alias: "fixture-box"))
    var finished = false
    let quit = Task { await hosts.disconnectAll(); finished = true }
    try await lifecycleEventually { await tunnel.disconnects == 1 }
    #expect(!finished)
    #expect(localClient.connected)
    #expect(hosts.sessions.first { $0.ref.host == remote }?.value.state == "working")
    #expect(hosts.sessions.first { $0.ref.host == remote }?.value.outcome == nil)
    await tunnel.finishCleanup()
    await quit.value
    #expect(finished)
    #expect(localClient.connected)
    #expect(hosts.available == [local])
    do {
        try await hosts.connect(host: remote, configuration: SSHConnectionConfiguration(alias: "fixture-box"))
        Issue.record("Quit allowed a late reconnect")
    } catch {}
}

@Test @MainActor func corruptHostIndexCannotBeUsedAsImplicitReenrollmentWhileLocalStaysUsable() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("hosts.json")
    let original = Data("not a valid host index".utf8)
    try original.write(to: file)
    var connected = false
    let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"), makeTunnel: { _, _ in
        connected = true
        return LifecycleTunnel(url: URL(string: "http://127.0.0.1:49004")!)
    })
    do { try await hosts.restoreOffline(from: OfflineHostStore(directory: directory)); Issue.record("Read corrupt index") }
    catch {}
    let remote = HostRef(hostId: "box", daemonId: "new", lineageId: "new")
    let configuration = try SSHConnectionConfiguration(alias: "fixture")
    do { try await hosts.enroll(remote, configuration: configuration); Issue.record("Re-enrolled past unreadable pins") }
    catch {}
    do { try await hosts.connect(host: remote, configuration: configuration); Issue.record("Connected past unreadable pins") }
    catch {}
    #expect(!connected)
    #expect(hosts.offlineHosts.isEmpty)
    #expect(try Data(contentsOf: file) == original)
    let local = HostRef(hostId: "local", daemonId: "local", lineageId: "1")
    try hosts.install(lifecycleClient(title: "Local"), host: local)
    #expect(hosts.available.contains(local))
}

@Test @MainActor func onlyCompleteAuthoritativePartitionCanReplaceOfflineRowsIncludingEmptySnapshots() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let remote = HostRef(hostId: "box", daemonId: "remote", lineageId: "r1")
    let local = HostRef(hostId: "local", daemonId: "local", lineageId: "l1")
    let snapshot = OfflineHostSnapshot(host: remote, configuration: try SSHConnectionConfiguration(alias: "fixture"),
        sessions: [SessionSummary(id: "same", title: "Remote", cwd: "/repo", createdAt: 0, updatedAt: 0, state: "working")])
    let store = OfflineHostStore(directory: directory.appendingPathComponent("hosts"))
    try await store.save([snapshot])
    let hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
    try await hosts.restoreOffline(from: store)
    try hosts.install(lifecycleClient(title: "Local"), host: local)
    let emptyConnectingEndpoint = PilotClient()
    try hosts.install(emptyConnectingEndpoint, host: remote)
    emptyConnectingEndpoint.handle(.projects([]))
    #expect(hosts.sessions.count == 2)
    #expect(hosts.sessions.first { $0.ref.host == remote }?.value.state == "working")
    let authoritative = PilotClient()
    authoritative.loadFixture(projects: [], sessions: [])
    try hosts.install(authoritative, host: remote)
    #expect(hosts.sessions.count == 1)
    #expect(hosts.sessions.first?.ref.host == local)
    #expect(hosts.offlineHosts[remote]?.sessions.isEmpty == true)
    await hosts.disconnect(remote)
    try await hosts.flushOffline()
}
