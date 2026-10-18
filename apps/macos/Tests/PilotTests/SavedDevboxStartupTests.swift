import Foundation
import PilotCore
import Testing
@testable import Pilot

private actor StartupDialCounter {
    private(set) var active = 0
    private(set) var maximum = 0
    func entered() { active += 1; maximum = max(maximum, active) }
    func exited() { active -= 1 }
}

private actor StartupTunnel: HostTunnel {
    let url: URL
    let held: Bool
    let fail: Bool
    let heldCleanup: Bool
    let counter: StartupDialCounter
    private let stream: AsyncStream<SSHTunnelState>
    private let continuation: AsyncStream<SSHTunnelState>.Continuation
    private var release: CheckedContinuation<Void, Never>?
    private var cleanupRelease: CheckedContinuation<Void, Never>?
    private(set) var calls = 0
    private(set) var disconnects = 0
    init(port: Int, held: Bool = false, fail: Bool = false, heldCleanup: Bool = false,
         counter: StartupDialCounter = StartupDialCounter()) {
        url = URL(string: "http://127.0.0.1:\(port)")!
        self.held = held; self.fail = fail; self.heldCleanup = heldCleanup; self.counter = counter
        let pair = AsyncStream<SSHTunnelState>.makeStream(bufferingPolicy: .bufferingNewest(1))
        stream = pair.stream; continuation = pair.continuation
        continuation.yield(.disconnected)
    }
    func states() -> AsyncStream<SSHTunnelState> { stream }
    func connect() async throws -> URL {
        calls += 1
        await counter.entered()
        continuation.yield(.connecting(attempt: 1))
        // Intentionally ignore cancellation until released: late success must still be fenced.
        if held { await withCheckedContinuation { release = $0 } }
        await counter.exited()
        if fail { continuation.yield(.failed(.sshExited(255))); throw SSHTunnelError.sshExited(255) }
        continuation.yield(.connected(url))
        return url
    }
    var waiting: Bool { release != nil }
    func finish() { release?.resume(); release = nil }
    func disconnect() async {
        disconnects += 1; continuation.yield(.disconnected)
        if heldCleanup { await withCheckedContinuation { cleanupRelease = $0 } }
    }
    var cleanupWaiting: Bool { cleanupRelease != nil }
    func finishCleanup() { cleanupRelease?.resume(); cleanupRelease = nil }
}

private final class StartupReceiptHTTP: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var paths: [String] = []
    static var requests: [String] { lock.lock(); defer { lock.unlock() }; return paths }
    static func reset() { lock.lock(); defer { lock.unlock() }; paths = [] }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "startup.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.paths.append(request.url!.path); Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"state\":\"unknown\"}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor private final class StartupFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let a = HostRef(hostId: "a", daemonId: "a-daemon", lineageId: "a-lineage")
    let b = HostRef(hostId: "b", daemonId: "b-daemon", lineageId: "b-lineage")
    let c = HostRef(hostId: "c", daemonId: "c-daemon", lineageId: "c-lineage")
    let local = HostRef(hostId: "local", daemonId: "local", lineageId: "local-lineage")
    var dials: [HostRef: Int] = [:]
    var aliases: [String] = []
    var runtimeReads: [HostRef: Int] = [:]
    var clients: [PilotClient] = []
    func configuration(_ host: HostRef) throws -> SSHConnectionConfiguration {
        try SSHConnectionConfiguration(alias: "fixture-\(host.hostId)")
    }
    func store(_ hosts: [HostRef]) async throws -> OfflineHostStore {
        let store = OfflineHostStore(directory: directory.appendingPathComponent("hosts"))
        try await store.save(hosts.map { host in
            OfflineHostSnapshot(host: host, configuration: try configuration(host), sessions: [
                SessionSummary(id: "same", title: host.hostId, cwd: "/repo", createdAt: 1, updatedAt: 1, state: "working"),
            ])
        })
        return store
    }
    func makeHosts(_ tunnels: [HostRef: StartupTunnel]) -> HostClients {
        HostClients(operationDirectory: directory.appendingPathComponent("operations"), makeTunnel: { [self] configuration, host in
            dials[host, default: 0] += 1; aliases.append(configuration.alias)
            return tunnels[host]!
        }, makeClient: { [self] in
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [StartupReceiptHTTP.self]
            let client = PilotClient(baseURL: URL(string: "http://startup.invalid")!, commandConfiguration: configuration)
            client.loadFixture(projects: [], sessions: [])
            clients.append(client)
            return client
        }, connectClient: { _, _ in }, readRuntimeHello: { [self] client, host in
            #expect(client.hostIdentity == host)
            runtimeReads[host, default: 0] += 1
            return try startupHello(host)
        })
    }
    func cleanup() { try? FileManager.default.removeItem(at: directory) }
}

private func startupHello(_ host: HostRef, version: String = "1.0.0") throws -> DaemonHello {
    let object: [String: Any] = ["daemonId": host.daemonId, "lineageId": host.lineageId, "daemonVersion": version,
        "protocolVersion": 1, "minimumClientProtocolVersion": 1, "platform": "linux", "arch": "x64",
        "capabilities": ["powerManagement": false, "systemSleepEvents": false, "swiftUIArtifacts": false,
                         "coordinatorIsolation": true, "independentExecution": true, "runtimeUpdates": 1]]
    return try JSONDecoder().decode(DaemonHello.self, from: JSONSerialization.data(withJSONObject: object))
}

@MainActor private func startupUntil(_ condition: () async -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    while !(await condition()) {
        guard ContinuousClock.now < deadline else { throw ClientError("Startup fixture timed out") }
        try await Task.sleep(for: .milliseconds(5))
    }
}

@Suite(.serialized) struct SavedDevboxStartupTests {
    @Test @MainActor func liveStartupStartsLocalWhileSavedPeersAreHeldOrFailAndReadsVersionsWithoutSettings() async throws {
        let fixture = StartupFixture()
        defer { fixture.cleanup() }
        let counter = StartupDialCounter()
        let a = StartupTunnel(port: 49001, held: true, counter: counter)
        let b = StartupTunnel(port: 49002, fail: true, counter: counter)
        let c = StartupTunnel(port: 49003, counter: counter)
        let hosts = fixture.makeHosts([fixture.a: a, fixture.b: b, fixture.c: c])
        let app = AppModel(hosts: hosts)
        var localStarted = false
        let store = try await fixture.store([fixture.a, fixture.b, fixture.c])
        await app.startHostConnections(offlineStore: store) {
            localStarted = true
            let localClient = PilotClient()
            localClient.loadFixture(projects: [], sessions: [])
            try? hosts.install(localClient, host: fixture.local)
        }
        #expect(localStarted && hosts.available.contains(fixture.local))
        try await startupUntil { await a.waiting && hosts.available.contains(fixture.c) }
        let manual = Task { try await hosts.reconnect(fixture.a) }
        hosts.startSavedConnections(); hosts.startSavedConnections()
        await a.finish()
        try await manual.value
        try await startupUntil { hosts.startupConnectionsIdle }
        #expect(fixture.dials == [fixture.a: 1, fixture.b: 1, fixture.c: 1])
        #expect(fixture.runtimeReads == [fixture.a: 1, fixture.c: 1])
        #expect(hosts.remoteRuntimes.observations[fixture.a]?.hello.daemonVersion == "1.0.0")
        #expect(hosts.remoteRuntimes.observations[fixture.b] == nil)
        #expect(!hosts.available.contains(fixture.b))
        #expect(hosts.sessions.first { $0.ref.host == fixture.b }?.value.state == "working")
        let maximum = await counter.maximum
        #expect(maximum <= SavedDevboxStartup.concurrency)
        await hosts.disconnectAll()
    }

    @Test @MainActor func genericRestoreAndConstructionNeverDialOrReadVersionsAndStartupOnlyLooksUpPendingReceipts() async throws {
        StartupReceiptHTTP.reset()
        let fixture = StartupFixture()
        defer { fixture.cleanup() }
        let a = StartupTunnel(port: 49004)
        let hosts = fixture.makeHosts([fixture.a: a])
        let outbox = OperationOutbox(directory: fixture.directory.appendingPathComponent("operations"))
        let operation = try await outbox.reserve(kind: "chat-create", targetId: UUID().uuidString,
            payload: ["message": "original"], origin: fixture.local, destination: fixture.a)
        let store = try await fixture.store([fixture.a])
        try await hosts.restoreOffline(from: store)
        #expect(fixture.dials.isEmpty && fixture.runtimeReads.isEmpty)
        #expect(hosts.pendingOperations[operation.operationId] == operation)
        hosts.startSavedConnections()
        try await startupUntil { hosts.startupConnectionsIdle && !StartupReceiptHTTP.requests.isEmpty }
        #expect(StartupReceiptHTTP.requests.allSatisfy { $0 == "/api/operations/receipt" })
        #expect(try await outbox.pending() == [operation])
        #expect(hosts.pendingOperations[operation.operationId] == operation)
        #expect(fixture.runtimeReads[fixture.a] == 1)
        await hosts.disconnectAll()
    }

    @Test @MainActor func explicitDisconnectBeforeAndDuringLaunchPreventsQueuedAndLateInstall() async throws {
        let fixture = StartupFixture()
        defer { fixture.cleanup() }
        let a = StartupTunnel(port: 49005, held: true)
        let b = StartupTunnel(port: 49006, held: true)
        let c = StartupTunnel(port: 49007)
        let hosts = fixture.makeHosts([fixture.a: a, fixture.b: b, fixture.c: c])
        try await hosts.restoreOffline(from: fixture.store([fixture.a, fixture.b, fixture.c]))
        hosts.startSavedConnections()
        try await startupUntil { let first = await a.waiting; let second = await b.waiting; return first && second }
        var manualEntered = false
        let queuedManual = Task { manualEntered = true; try await hosts.reconnect(fixture.c) }
        try await startupUntil { manualEntered }
        for _ in 0..<10 { await Task.yield() }
        #expect(fixture.dials[fixture.c] == nil, "A manual click shares the global startup connection bound")
        await hosts.disconnect(fixture.c) // Removal uses this same owned-connection barrier.
        await hosts.disconnect(fixture.a)
        await a.finish(); await b.finish()
        if case .success = await queuedManual.result { Issue.record("Disconnected queued manual connection was admitted") }
        try await startupUntil { hosts.startupConnectionsIdle }
        #expect(fixture.dials[fixture.c] == nil)
        #expect(!hosts.available.contains(fixture.a) && !hosts.available.contains(fixture.c))
        #expect(fixture.runtimeReads[fixture.a] == nil)
        hosts.startSavedConnections()
        #expect(fixture.dials[fixture.c] == nil)
        // An explicit manual reconnect is still allowed, without re-enrollment or a new launch retry.
        try await hosts.reconnect(fixture.c)
        try await startupUntil { hosts.available.contains(fixture.c) }
        await hosts.disconnectAll()
    }

    @Test @MainActor func replacedSavedCoordinatesAndShutdownFenceHeldAndQueuedAttempts() async throws {
        let fixture = StartupFixture()
        defer { fixture.cleanup() }
        let a = StartupTunnel(port: 49008, held: true)
        let b = StartupTunnel(port: 49009, held: true)
        let c = StartupTunnel(port: 49010)
        let hosts = fixture.makeHosts([fixture.a: a, fixture.b: b, fixture.c: c])
        try await hosts.restoreOffline(from: fixture.store([fixture.a, fixture.b, fixture.c]))
        hosts.startSavedConnections()
        try await startupUntil { let first = await a.waiting; let second = await b.waiting; return first && second }
        try await hosts.enroll(fixture.c, configuration: SSHConnectionConfiguration(alias: "replacement-coordinates"))
        await hosts.disconnectAll()
        await a.finish(); await b.finish()
        try await startupUntil { hosts.startupConnectionsIdle }
        #expect(fixture.dials[fixture.c] == nil && hosts.available.isEmpty)
        #expect(fixture.clients.isEmpty && fixture.runtimeReads.isEmpty)
        hosts.startSavedConnections()
        #expect(fixture.dials.count == 2)
    }

    @Test @MainActor func corruptRestoreKeepsLocalUsableWithoutImplicitEnrollmentOrDial() async throws {
        let fixture = StartupFixture()
        defer { fixture.cleanup() }
        let store = OfflineHostStore(directory: fixture.directory.appendingPathComponent("hosts"))
        try FileManager.default.createDirectory(at: fixture.directory.appendingPathComponent("hosts"), withIntermediateDirectories: true)
        let file = fixture.directory.appendingPathComponent("hosts/hosts.json")
        let original = Data("corrupt".utf8)
        try original.write(to: file)
        let hosts = fixture.makeHosts([:])
        let app = AppModel(hosts: hosts)
        var localStarts = 0
        await app.startHostConnections(offlineStore: store) { localStarts += 1 }
        hosts.startSavedConnections()
        #expect(localStarts == 1 && app.sessionActionError != nil)
        #expect(fixture.dials.isEmpty && fixture.runtimeReads.isEmpty)
        #expect(try Data(contentsOf: file) == original)
    }

    @Test @MainActor func disconnectBeforeLiveAdmissionIsNotUndoneByRepeatedStartup() async throws {
        let fixture = StartupFixture()
        defer { fixture.cleanup() }
        let hosts = fixture.makeHosts([fixture.a: StartupTunnel(port: 49011)])
        try await hosts.restoreOffline(from: fixture.store([fixture.a]))
        await hosts.disconnect(fixture.a)
        hosts.startSavedConnections(); hosts.startSavedConnections()
        #expect(hosts.startupConnectionsIdle && fixture.dials.isEmpty && fixture.runtimeReads.isEmpty)
        await hosts.disconnectAll()
    }

    @Test @MainActor func quitJoinsCleanupAlreadyOwnedByManualDisconnectAndFencesReconnection() async throws {
        let fixture = StartupFixture()
        defer { fixture.cleanup() }
        let tunnel = StartupTunnel(port: 49012, heldCleanup: true)
        let hosts = fixture.makeHosts([fixture.a: tunnel])
        try await hosts.restoreOffline(from: fixture.store([fixture.a]))
        hosts.startSavedConnections()
        try await startupUntil { hosts.available.contains(fixture.a) && hosts.startupConnectionsIdle }
        let disconnect = Task { await hosts.disconnect(fixture.a) }
        try await startupUntil { await tunnel.cleanupWaiting }
        let reconnect = Task { try await hosts.reconnect(fixture.a) }
        var quitFinished = false
        var quitEntered = false
        let quit = Task { quitEntered = true; await hosts.disconnectAll(); quitFinished = true }
        try await startupUntil { quitEntered }
        for _ in 0..<10 { await Task.yield() }
        #expect(!quitFinished, "Quit must join the already-retiring owned SSH forward")
        await tunnel.finishCleanup()
        await disconnect.value
        await quit.value
        _ = await reconnect.result
        #expect(fixture.dials[fixture.a] == 1 && hosts.available.isEmpty)
        #expect(hosts.remoteRuntimes.observations.isEmpty)
    }
}

@MainActor private final class RuntimeReadFixture {
    var calls: [HostRef: Int] = [:]
    var versions: [HostRef: String] = [:]
    var wrongIdentity: Set<HostRef> = []
    var held: Set<HostRef> = []
    var waits: [HostRef: CheckedContinuation<Void, Never>] = [:]
    var active = 0
    var maximum = 0
    func endpoint(_ host: HostRef, token: HostConnectionToken? = nil) -> VerifiedRemoteRuntimes.Endpoint {
        VerifiedRemoteRuntimes.Endpoint(token: token ?? HostConnectionToken(host: host), isCurrent: { true }, hello: { [self] in
            calls[host, default: 0] += 1
            active += 1; maximum = max(maximum, active)
            defer { active -= 1 }
            let version = versions[host] ?? "1.0.0"
            if held.contains(host) { await withCheckedContinuation { waits[host] = $0 } }
            let identity = wrongIdentity.contains(host) ? HostRef(hostId: host.hostId, daemonId: "foreign", lineageId: "foreign") : host
            return try startupHello(identity, version: version)
        })
    }
    func release(_ host: HostRef) { held.remove(host); waits.removeValue(forKey: host)?.resume() }
}

@Suite struct VerifiedRemoteRuntimeTests {
    private let a = HostRef(hostId: "a", daemonId: "a", lineageId: "a1")
    private let b = HostRef(hostId: "b", daemonId: "b", lineageId: "b1")
    private let c = HostRef(hostId: "c", daemonId: "c", lineageId: "c1")

    @Test @MainActor func lifecycleVersionReadsAreBoundedAndOncePerVerifiedGeneration() async throws {
        let fixture = RuntimeReadFixture()
        fixture.held = [a, b, c]
        let reader = VerifiedRemoteRuntimes()
        let endpoints = Dictionary(uniqueKeysWithValues: [a, b, c].map { ($0, fixture.endpoint($0)) })
        reader.update(endpoints)
        try await startupUntil { fixture.waits.count == 2 }
        #expect(fixture.maximum == 2 && fixture.calls.values.reduce(0, +) == 2)
        let first = try #require(fixture.waits.keys.first)
        fixture.release(first)
        try await startupUntil { fixture.calls.count == 3 }
        for host in [a, b, c] { fixture.release(host) }
        try await startupUntil { reader.isIdle }
        reader.update(endpoints); reader.update(endpoints)
        #expect(fixture.calls == [a: 1, b: 1, c: 1])
        #expect(reader.observations.count == 3 && fixture.maximum == 2)
        reader.stop()
    }

    @Test @MainActor func replacedGenerationAndQuitDiscardLateHelloWithoutInferringVersion() async throws {
        let fixture = RuntimeReadFixture()
        fixture.held.insert(a)
        let reader = VerifiedRemoteRuntimes()
        reader.update([a: fixture.endpoint(a)])
        try await startupUntil { fixture.waits[a] != nil }
        let newToken = HostConnectionToken(host: a)
        fixture.versions[a] = "2.0.0"
        reader.update([a: fixture.endpoint(a, token: newToken)])
        #expect(reader.observations.isEmpty)
        fixture.release(a)
        try await startupUntil { reader.isIdle }
        #expect(reader.observations[a]?.token == newToken && reader.observations[a]?.hello.daemonVersion == "2.0.0")
        fixture.held.insert(a)
        reader.update([a: fixture.endpoint(a)])
        try await startupUntil { fixture.waits[a] != nil }
        reader.stop()
        fixture.release(a)
        try await startupUntil { reader.isIdle }
        #expect(reader.observations.isEmpty)
    }

    @Test @MainActor func wrongIdentityAndUnknownVersionFailClosedWithoutSameGenerationRetry() async throws {
        let fixture = RuntimeReadFixture()
        fixture.wrongIdentity.insert(a)
        fixture.versions[b] = ""
        let reader = VerifiedRemoteRuntimes()
        let endpoints = [a: fixture.endpoint(a), b: fixture.endpoint(b)]
        reader.update(endpoints)
        try await startupUntil { reader.isIdle }
        reader.update(endpoints)
        #expect(reader.observations.isEmpty && reader.failures == [a, b])
        #expect(fixture.calls == [a: 1, b: 1])
        reader.update([:])
        #expect(reader.failures.isEmpty)
        reader.stop()
    }
}
