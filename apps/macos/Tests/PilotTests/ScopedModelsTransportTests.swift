import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class ScopeHTTPFixture: URLProtocol {
    struct Host {
        var patterns: [String]? = ["old/model"]
        var hash = "old-hash"
        var mode = "normal"
        var status = 200
        var error = ""
    }
    struct Request {
        let host: String
        let method: String
        let hasCorrectCapability: Bool
        let explicitNull: Bool
    }
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var hosts: [String: Host] = [:]
        var requests: [Request] = []
    }
    private static let state = State()
    static func reset(_ hosts: [String: Host]) {
        state.lock.lock(); defer { state.lock.unlock() }
        state.hosts = hosts; state.requests = []
    }
    static var requests: [Request] {
        state.lock.lock(); defer { state.lock.unlock() }; return state.requests
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".scope.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!, host = url.host!.replacingOccurrences(of: ".scope.invalid", with: "")
        let method = request.httpMethod ?? "GET"
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while data.count <= 160 * 1024 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        Self.state.lock.lock()
        var value = Self.state.hosts[host] ?? Host()
        let correct = request.value(forHTTPHeaderField: "x-pilot-github-capability") == "fixture-\(host)"
        Self.state.requests.append(.init(host: host, method: method, hasCorrectCapability: correct,
                                         explicitNull: body["enabledModels"] is NSNull))
        var status = value.status
        var response: [String: Any]
        if status != 200 { response = ["error": value.error] }
        else if method == "PUT" {
            if !correct { status = 403; response = ["error": "native_action_required"] }
            else if value.mode == "conflict" {
                status = 409; response = ["error": "scope_conflict", "scopeHash": value.hash, "enabledModels": value.patterns as Any? ?? NSNull()]
            } else {
                value.patterns = body["enabledModels"] as? [String]
                value.hash = "new-hash"
                Self.state.hosts[host] = value
                if value.mode == "commit-503" { status = 503; response = ["error": "model_scope_unavailable"] }
                else if value.mode == "unchanged" { response = ["changed": false, "scopeHash": value.hash] }
                else { response = Self.snapshot(value); response["changed"] = true }
            }
        } else { response = Self.snapshot(value) }
        Self.state.lock.unlock()
        do {
            let bytes = try JSONSerialization.data(withJSONObject: response)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: bytes)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    private static func snapshot(_ host: Host) -> [String: Any] {
        ["enabledModels": host.patterns as Any? ?? NSNull(), "allModels": host.patterns?.isEmpty != false,
         "scopeHash": host.hash, "resolution": [],
         "candidates": [["id": "provider/outside-current-scope", "provider": "provider", "name": "Outside current scope"]]]
    }
    override func stopLoading() {}
}

@MainActor private func scopeTransportClient(_ name: String) throws -> (PilotClient, HostRef) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ScopeHTTPFixture.self]
    let client = PilotClient(baseURL: URL(string: "http://\(name).scope.invalid"), commandConfiguration: configuration)
    let host = HostRef(hostId: name, daemonId: "daemon-\(name)", lineageId: "history-\(name)")
    try client.bind(host)
    client.loadFixture(projects: [], sessions: [])
    return (client, host)
}

@MainActor private func scopeTransport(_ client: PilotClient, host: HostRef,
                                      capability: @escaping () async throws -> String) -> ScopedModelsTransport {
    let token = HostConnectionToken(host: host, generation: client.connectionGeneration)
    return ScopedModelsTransport(client: client, token: token, validate: {
        guard client.connected, client.hostIdentity == host, client.connectionGeneration == token.generation else {
            throw HostRoutingError.staleGeneration
        }
    }, capability: capability)
}

@Suite(.serialized) struct ScopedModelsTransportTests {
    @Test @MainActor func modelScopeLiveConflictAndLeaveRemainDivergentAfterColdLaunch() async throws {
        ScopeHTTPFixture.reset(["local": .init(mode: "conflict")])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (client, host) = try scopeTransportClient("local")
        let store = ScopedModelsStore(directory: directory)
        let sync = LocalModelScope(store: store)
        sync.update(scopeTransport(client, host: host, capability: { "fixture-local" }).endpoint())
        await sync.start()
        try await wireScopeWait { sync.observations[host] != nil && sync.isIdle }
        let baseline = try #require(sync.observations[host]?.baseline)
        await sync.save(.all, on: host, baseline: baseline)
        try await wireScopeWait { sync.state.entry(host)?.status == .conflict && sync.isIdle }
        #expect(ScopeHTTPFixture.requests.filter { $0.method == "PUT" }.count == 1)
        await sync.leave(host)
        await sync.stopAndWait(); client.disconnect()
        let (nextClient, _) = try scopeTransportClient("local")
        let next = LocalModelScope(store: ScopedModelsStore(directory: directory))
        next.update(scopeTransport(nextClient, host: host, capability: { Issue.record("Left-as-is host must not acquire capability"); return "fixture-local" }).endpoint())
        await next.start()
        try await wireScopeWait { next.observations[host] != nil && next.isIdle }
        #expect(next.state.entry(host)?.status == .divergent)
        #expect(ScopeHTTPFixture.requests.filter { $0.method == "PUT" }.count == 1)
        await next.stopAndWait(); nextClient.disconnect()
    }

    @Test @MainActor func modelScopeWirePreservesAllAndDecodesBothPutArmsWithoutCapabilityReadsOnGet() async throws {
        for mode in ["normal", "unchanged"] {
            ScopeHTTPFixture.reset(["local": .init(mode: mode)])
            let (client, host) = try scopeTransportClient("local")
            defer { client.disconnect() }
            var acquisitions = 0
            let adapter = scopeTransport(client, host: host) { acquisitions += 1; return "fixture-local" }
            let initial = try await adapter.read()
            #expect(acquisitions == 0)
            #expect(initial.candidates.first?.id == "provider/outside-current-scope")
            try await adapter.write(.all, expectedHash: initial.baseline.hash)
            let applied = try await adapter.read()
            #expect(applied.baseline.patterns == nil && acquisitions == 1)
            #expect(ScopeHTTPFixture.requests.map(\.method) == ["GET", "PUT", "GET"])
            let put = try #require(ScopeHTTPFixture.requests.first { $0.method == "PUT" })
            #expect(put.explicitNull && put.hasCorrectCapability)
        }
    }

    @Test @MainActor func modelScopeWireRejectsStaleCapabilityAcquisitionBeforeSending() async throws {
        ScopeHTTPFixture.reset(["local": .init()])
        let (client, host) = try scopeTransportClient("local")
        let adapter = scopeTransport(client, host: host) {
            client.disconnect()
            return "fixture-local"
        }
        do { try await adapter.write(.all, expectedHash: "old-hash"); Issue.record("Stale capability cannot be sent") }
        catch { #expect(error as? HostRoutingError == .staleGeneration) }
        #expect(ScopeHTTPFixture.requests.isEmpty)
    }

    @Test @MainActor func modelScopeWireExposesTypedReadFailuresWithoutTreatingThemAsAbsent() async throws {
        for (status, code, expected) in [(404, "missing", ScopedModelsHostStatus.unsupported),
                                        (403, "read_only", .readOnly), (403, "native_action_required", .authorizationRequired),
                                        (422, "settings_unreadable", .settingsUnreadable), (503, "settings_unreadable", .settingsUnreadable)] {
            ScopeHTTPFixture.reset(["local": .init(status: status, error: code)])
            let (client, host) = try scopeTransportClient("local")
            defer { client.disconnect() }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let sync = LocalModelScope(store: ScopedModelsStore(directory: directory))
            defer { sync.stop() }
            sync.update(scopeTransport(client, host: host, capability: { Issue.record("GET must not read native capability"); return "fixture-local" }).endpoint())
            await sync.start()
            let deadline = Date().addingTimeInterval(10)
            while sync.state.entry(host)?.status != expected, Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
            #expect(sync.state.entry(host)?.status == expected)
            #expect(sync.observations[host] == nil && sync.state.desired == nil)
            #expect(ScopeHTTPFixture.requests.allSatisfy { $0.method == "GET" })
        }
    }

    @Test @MainActor func modelScopeWireReconcilesCommitted503WithLiteralReadbackWithoutRepeatingPut() async throws {
        ScopeHTTPFixture.reset(["local": .init(mode: "commit-503")])
        let (client, host) = try scopeTransportClient("local")
        defer { client.disconnect() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let sync = LocalModelScope(store: ScopedModelsStore(directory: directory))
        defer { sync.stop() }
        sync.update(scopeTransport(client, host: host, capability: { "fixture-local" }).endpoint())
        await sync.start()
        var deadline = Date().addingTimeInterval(10)
        while sync.observations[host] == nil || !sync.checking.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        let initial = try #require(sync.observations[host])
        await sync.save(.all, on: host, baseline: initial.baseline)
        deadline = Date().addingTimeInterval(10)
        while sync.state.entry(host)?.status != .synced, Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        #expect(sync.state.entry(host)?.status == .synced)
        #expect(ScopeHTTPFixture.requests.filter { $0.method == "PUT" }.count == 1)
    }
}

@MainActor private func wireScopeWait(_ ready: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(10)
    while !ready(), Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
    try #require(ready())
}
