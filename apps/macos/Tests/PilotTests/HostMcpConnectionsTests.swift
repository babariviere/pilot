import Combine
import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class HostMcpHTTP: URLProtocol {
    struct State {
        var sourceRevision = "source"
        var targetRevision = "target"
        var targetEntries: [McpSetupEntry] = []
        var requests: [String] = []
        var wrongCapability = false
        var committed503 = false
    }
    private final class Storage: @unchecked Sendable { let lock = NSLock(); var value = State() }
    private static let storage = Storage()
    static func reset() { storage.lock.lock(); defer { storage.lock.unlock() }; storage.value = State() }
    static func change(_ edit: (inout State) -> Void) { storage.lock.lock(); defer { storage.lock.unlock() }; edit(&storage.value) }
    static var state: State { storage.lock.lock(); defer { storage.lock.unlock() }; return storage.value }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".mcp.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!, host = url.host!.components(separatedBy: ".")[0], method = request.httpMethod ?? "GET"
        var bytes = request.httpBody ?? Data()
        if bytes.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 2048)
            while bytes.count < 160 * 1024 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }; bytes.append(contentsOf: buffer.prefix(count))
            }
        }
        Self.storage.lock.lock()
        Self.storage.value.requests.append("\(host) \(method) \(url.path)")
        var status = 200
        let data: Data
        do {
            if url.path == "/api/mcp/setup" {
                if request.value(forHTTPHeaderField: "x-pilot-github-capability") != "fixture-\(host)" {
                    Self.storage.value.wrongCapability = true; throw McpSetupFailure.invalid
                }
                if method == "PUT" {
                    let input = try JSONDecoder().decode(McpSetupApplyRequest.self, from: bytes)
                    #expect(host == "box")
                    Self.storage.value.targetEntries = input.entries.map { .init(name: $0.name, config: $0.config) }
                    Self.storage.value.targetRevision = "applied"
                    if Self.storage.value.committed503 { status = 503 }
                }
                let snapshot = McpSetupSnapshot(revision: host == "local" ? Self.storage.value.sourceRevision : Self.storage.value.targetRevision,
                    exists: host == "local" || !Self.storage.value.targetEntries.isEmpty,
                    entries: host == "local" ? [McpSetupEntry(name: "same", config: .init(url: "https://example.test/mcp")),
                                               McpSetupEntry(name: "private", blocked: "advanced_configuration")]
                        : Self.storage.value.targetEntries)
                data = status == 503 ? Data("{\"error\":\"mcp_setup_unavailable\"}".utf8) : try JSONEncoder().encode(snapshot)
            } else if method == "DELETE" || url.path.hasSuffix("sign-in") {
                data = try JSONEncoder().encode(McpSignInState(state: method == "DELETE" ? .cancelled : .waiting,
                    startedAt: 1, expiresAt: 999999))
            } else {
                data = try JSONEncoder().encode(McpStatus(servers: [McpServerStatus(name: "same", transport: .http,
                    state: .needsSignIn, canSignIn: true)]))
            }
        } catch { status = 400; data = Data("{\"error\":\"invalid_setup\"}".utf8) }
        Self.storage.lock.unlock()
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
            headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor private final class HostMcpFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let local = HostRef(hostId: "local", daemonId: "local-daemon", lineageId: "local-history")
    let box = HostRef(hostId: "box", daemonId: "box-daemon", lineageId: "box-history")
    lazy var hosts = HostClients(operationDirectory: directory.appendingPathComponent("operations"))
    var clients: [HostRef: PilotClient] = [:]
    var capabilities: [HostRef] = []
    func prepare() async throws {
        HostMcpHTTP.reset()
        let offline = OfflineHostStore(directory: directory.appendingPathComponent("offline"))
        try await offline.save([OfflineHostSnapshot(host: box, configuration: SSHConnectionConfiguration(alias: "fixture"))])
        try await hosts.restoreOffline(from: offline)
        for host in [local, box] {
            let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [HostMcpHTTP.self]
            let client = PilotClient(baseURL: URL(string: "http://\(host.hostId).mcp.invalid"), commandConfiguration: configuration)
            client.loadFixture(projects: [], sessions: []); clients[host] = client
            try hosts.install(client, host: host)
        }
    }
    func sharing() -> McpSetupSharing {
        McpSetupSharing(source: local, target: box, hosts: hosts) { host, configuration in
            #expect((configuration == nil) == (host == self.local))
            self.capabilities.append(host)
            return "fixture-\(host.hostId)"
        }
    }
    func close() async { await hosts.disconnectAll(); try? FileManager.default.removeItem(at: directory) }
}

@MainActor private func withHostMcp(_ body: (HostMcpFixture) async throws -> Void) async throws {
    let f = HostMcpFixture()
    do { try await f.prepare(); try await body(f); await f.close() }
    catch { await f.close(); throw error }
}

@Suite(.serialized) struct HostMcpConnectionsTests {
    @Test @MainActor func hostMcpRosterCoalescesUnchangedPresentationWithoutStartingChecks() async throws {
        try await withHostMcp { f in
            let roster = HostMcpRoster(hosts: f.hosts, local: f.local)
            #expect(roster.rows.map(\.host) == [f.local, f.box])
            var publications = 0
            let observation = roster.$rows.dropFirst().sink { _ in publications += 1 }
            for _ in 0..<100 { roster.update(local: f.local) }
            #expect(publications == 0 && HostMcpHTTP.state.requests.isEmpty)
            await f.hosts.disconnect(f.box)
            #expect(roster.rows.first(where: { $0.host == f.box })?.available == false)
            withExtendedLifetime(observation) {}
        }
    }
    @Test @MainActor func hostMcpActionsRouteDuplicateNamesAndCancelToTheExactHost() async throws {
        try await withHostMcp { f in
            let local = HostMcpActions(host: f.local, hosts: f.hosts)
            let remote = HostMcpActions(host: f.box, hosts: f.hosts)
            await local.perform(.check); await remote.perform(.check)
            await local.perform(.signIn, server: "same")
            await remote.perform(.signIn, server: "same")
            #expect(remote.signInOnHost == "same")
            f.clients[f.box]?.mcp.recordSignIn("same", .init(state: .waiting, startedAt: 1, expiresAt: 999999))
            await remote.perform(.cancel(startedAt: 1), server: "same")
            let requests = HostMcpHTTP.state.requests
            #expect(requests.contains("local POST /api/mcp/check"))
            #expect(requests.contains("box POST /api/mcp/check"))
            #expect(requests.contains("local POST /api/mcp/servers/same/sign-in"))
            #expect(!requests.contains("box POST /api/mcp/servers/same/sign-in"))
            #expect(requests.contains("box DELETE /api/mcp/servers/same/sign-in"))
            #expect(f.clients[f.local]?.mcp.status?.server(named: "same")?.signIn?.state == .waiting)
            #expect(f.clients[f.box]?.mcp.status?.server(named: "same")?.signIn?.state == .cancelled)
            await remote.perform(.signInAgain, server: "same")
            #expect(remote.signInAgainOnHost && remote.signInOnHost == "same")
            #expect(!HostMcpHTTP.state.requests.contains("box POST /api/mcp/servers/same/sign-in"))
            #expect(f.capabilities.isEmpty)
        }
    }

    @Test @MainActor func hostMcpReviewedSetupUsesHostCapabilitiesAndReconcilesCommitted503WithoutReplay() async throws {
        try await withHostMcp { f in
            let sharing = f.sharing()
            #expect(HostMcpHTTP.state.requests.isEmpty && f.capabilities.isEmpty)
            await sharing.prepare()
            let review = try #require(sharing.review)
            #expect(sharing.selectable(review.local.entries[0]))
            #expect(!sharing.selectable(review.local.entries[1]))
            sharing.selected = ["same"]
            HostMcpHTTP.change { $0.committed503 = true }
            await sharing.apply()
            #expect(!sharing.uncertain && sharing.notice != nil)
            await sharing.apply()
            #expect(HostMcpHTTP.state.requests.filter { $0.contains("PUT") } == ["box PUT /api/mcp/setup"])
            #expect(!HostMcpHTTP.state.wrongCapability)
            #expect(Set(f.capabilities) == Set([f.local, f.box]))
        }
    }

    @Test @MainActor func hostMcpSourceAndTargetEditsOrExistingNamespacesRequireNewReview() async throws {
        try await withHostMcp { f in
            for sourceEdit in [true, false] {
                let sharing = f.sharing(); await sharing.prepare(); sharing.selected = ["same"]
                HostMcpHTTP.change { if sourceEdit { $0.sourceRevision += "x" } else { $0.targetRevision += "x" } }
                await sharing.apply()
                #expect(sharing.problem != nil && !sharing.uncertain)
            }
            HostMcpHTTP.change { $0.targetEntries = [.init(name: "same", blocked: "advanced_configuration")] }
            let sharing = f.sharing(); await sharing.prepare()
            let review = try #require(sharing.review)
            #expect(!sharing.selectable(review.local.entries[0]))
            #expect(HostMcpHTTP.state.requests.allSatisfy { !$0.contains("PUT") })
        }
    }

    @Test @MainActor func hostMcpDisconnectDuringCapabilityReadCannotDispatchToReplacement() async throws {
        try await withHostMcp { f in
            let client = try #require(f.clients[f.box])
            let token = try f.hosts.token(for: f.box)
            var current = true
            let transport = McpSetupTransport(client: client, token: token, current: { current }, capability: {
                current = false; return "fixture-box"
            })
            do { _ = try await transport.read(); Issue.record("Stale capability dispatched") } catch {}
            #expect(HostMcpHTTP.state.requests.isEmpty)
            await f.hosts.disconnect(f.box)
            await HostMcpActions(host: f.box, hosts: f.hosts).perform(.check)
            #expect(HostMcpHTTP.state.requests.isEmpty)
        }
    }

    @Test @MainActor func hostMcpUncertainApplyOnlyLooksUpTheSamePinAfterReconnect() async throws {
        let local = HostRef(hostId: "local", daemonId: "local", lineageId: "local")
        let box = HostRef(hostId: "box", daemonId: "box", lineageId: "box")
        let entry = McpSetupApplyRequest.Entry(name: "same", config: .init(url: "https://example.test/mcp"))
        var connected = true, applied = false, writes = 0
        let sharing = McpSetupSharing(source: local, target: box) { host in
            let token = HostConnectionToken(host: host)
            return .init(token: token, current: { connected }, read: {
                McpSetupSnapshot(revision: "baseline", exists: host == local || applied,
                    entries: host == local || applied ? [.init(name: entry.name, config: entry.config)] : [])
            }, apply: { _ in writes += 1; applied = true; connected = false; throw McpSetupFailure.unavailable })
        }
        await sharing.prepare(); sharing.selected = ["same"]; await sharing.apply()
        #expect(sharing.uncertain && writes == 1)
        connected = true
        await sharing.apply(); await sharing.checkResult()
        #expect(writes == 1 && !sharing.uncertain)
    }

    @Test func hostMcpNativeProjectionRejectsSecretsAndLocalPaths() throws {
        for config in [McpShareConfig(url: "https://user:secret@example.test/mcp"),
                       .init(url: "https://example.test/mcp?token=secret"), .init(command: "/Users/person/bin/example"),
                       .init(command: "example", args: ["secret"]), .init(command: "example", env: ["TOKEN": "secret"]),
                       .init(url: "https://localhost./mcp")] {
            #expect(!config.shareable)
        }
        #expect(McpShareConfig(url: "https://example.test/mcp").shareable)
        #expect(McpShareConfig(url: "HTTPS://EXAMPLE.TEST:443/mcp").shareable)
        for text in [#"{"url":"https://example.test/mcp","futureAuth":"private-token"}"#,
                     #"{"url":"https://example.test/mcp","enabled":null}"#] {
            do { _ = try JSONDecoder().decode(McpShareConfig.self, from: Data(text.utf8)); Issue.record("Unknown/null setup field was silently stripped") }
            catch {}
        }
    }

    @Test @MainActor func hostMcpDelayedResultsAndReplacementPinsCannotPublishOrRetarget() async throws {
        let local = HostRef(hostId: "local", daemonId: "local", lineageId: "local")
        let box = HostRef(hostId: "box", daemonId: "box", lineageId: "box")
        let clone = HostRef(hostId: "box", daemonId: "replacement", lineageId: "replacement")
        var current = true, reads: [HostRef] = [], dispatches = 0
        let sharing = McpSetupSharing(source: local, target: box) { host in
            .init(token: .init(host: host), current: { current }, read: {
                reads.append(host); await Task.yield(); current = false
                return McpSetupSnapshot(revision: "old", exists: false, entries: [])
            }, apply: { _ in dispatches += 1 })
        }
        await sharing.prepare()
        #expect(sharing.review == nil && reads == [local] && dispatches == 0)
        current = true
        let replaced = HostMcpActions(host: box) {
            .init(token: .init(host: clone), isCurrent: { true }, perform: { _, _ in dispatches += 1 })
        }
        await replaced.perform(.check)
        #expect(dispatches == 0)
        let delayed = HostMcpActions(host: box) {
            .init(token: .init(host: box), isCurrent: { current }, perform: { _, _ in
                await Task.yield(); current = false; throw URLError(.networkConnectionLost)
            })
        }
        await delayed.perform(.check)
        #expect(delayed.problem == nil && !delayed.busy)
    }
}
