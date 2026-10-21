import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class UsageProjectionHTTP: URLProtocol {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var paths: [String] = []
    }
    private static let state = State()
    static func reset() { state.lock.lock(); defer { state.lock.unlock() }; state.paths = [] }
    static var paths: [String] { state.lock.lock(); defer { state.lock.unlock() }; return state.paths }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".usage.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let name = String(url.host!.split(separator: ".")[0])
        Self.state.lock.lock(); Self.state.paths.append("\(name):\(request.httpMethod ?? ""):\(url.path)"); Self.state.lock.unlock()
        let body: Data
        var status = 200
        if url.path == "/api/hello" {
            let capability = name == "old" ? "" : ",\"usageQueries\":1"
            let identity = name == "changed" ? "unexpected" : name
            body = Data("""
                {"daemonId":"\(identity)","lineageId":"lineage","daemonVersion":"test","protocolVersion":1,
                 "minimumClientProtocolVersion":1,"platform":"faux","arch":"faux","capabilities":{
                 "powerManagement":false,"systemSleepEvents":false,"swiftUIArtifacts":false,
                 "coordinatorIsolation":false,"independentExecution":true\(capability)}}
                """.utf8)
        } else if url.path == "/api/usage-history/query", name == "local" {
            var root = URL(fileURLWithPath: #filePath)
            for _ in 0..<5 { root.deleteLastPathComponent() }
            let encoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "query" }?.value
            let query = encoded.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(UsageAnalyticsQuery.self, from: $0) }
            if let limit = query?.limit, limit > 100 {
                status = 400; body = Data("{}".utf8) // Same bound as usageAnalyticsQuery in the daemon.
            } else {
                body = (try? Data(contentsOf: root.appendingPathComponent("packages/protocol/fixtures/usage-analytics.json"))) ?? Data()
            }
        } else {
            status = name == "limited" ? 429 : 503
            body = Data("{}".utf8)
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
            headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Test(.timeLimit(.minutes(1))) @MainActor
func usageLocalConsumerNeverFansOutAndDeferredHelperRequiresExplicitHosts() async throws {
    UsageProjectionHTTP.reset()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let hosts = ClientDirectory(operationDirectory: directory.appendingPathComponent("operations"))
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [UsageProjectionHTTP.self]
    var refs: [String: HostRef] = [:]
    for name in ["local", "old", "failed", "limited", "changed", "offline"] {
        let ref = HostRef(hostId: name, daemonId: name, lineageId: "lineage")
        let client = PilotClient(baseURL: URL(string: "http://\(name).usage.invalid"), commandConfiguration: configuration)
        client.loadFixture(projects: [], sessions: [])
        try loadClientFixture(client, host: ref, into: hosts)
        refs[name] = ref
    }
    let offline = try #require(refs["offline"])
    await hosts.disconnect(offline)
    let alias = HostRef(hostId: "zz-alias", daemonId: "local", lineageId: "lineage")
    let aliasClient = PilotClient(baseURL: URL(string: "http://alias.usage.invalid"), commandConfiguration: configuration)
    aliasClient.loadFixture(projects: [], sessions: [])
    try loadClientFixture(aliasClient, host: alias, into: hosts)
    let query = UsageAnalyticsQuery(from: 0, to: 86400000)
    let local = try await hosts.localUsage(query)
    #expect(local.hosts.count == 1)
    #expect(local.hosts.first?.host.hostId == "local")
    #expect(local.hosts.first?.result?.total.metrics["input"]?.unknown == 1)
    #expect(UsageProjectionHTTP.paths.allSatisfy { $0.hasPrefix("local:") })
    // Exercise the production directory/model/HTTP path. The old 400-group trend request
    // returned 400 and immediately erased the overview with a misleading identity warning.
    let dashboard = UsageDashboardModel(hosts: hosts)
    defer { dashboard.stop() }
    let scope = UsageDashboardModel.Scope(window: .init(from: 0, to: 86400000))
    for _ in 0..<2 {
        dashboard.refresh(scope, force: true)
        let deadline = Date().addingTimeInterval(5)
        while (dashboard.state == .loading || dashboard.trendLoading), Date() < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(dashboard.state == .ready && !dashboard.trendFailed && !dashboard.trendLoading)
        #expect(dashboard.summary?.total.records == 2)
        dashboard.connectionChanged()
        #expect(dashboard.state == .ready, "One explicit refresh must stay accepted on a stable connection")
    }
    #expect(UsageProjectionHTTP.paths.allSatisfy { $0.hasPrefix("local:") })
    dashboard.stop()
    UsageProjectionHTTP.reset()
    // Saved identities remain coverage metadata, never executable usage targets.
    let result = try await hosts.usageProjection(query, on: Set(refs.values).union([alias]))
    #expect(result.hosts.first { $0.host == refs["local"] }?.result?.total.metrics["input"]?.unknown == 1)
    #expect(result.hosts.first { $0.host == refs["old"] }?.state == "disconnected")
    #expect(result.hosts.first { $0.host == refs["failed"] }?.state == "disconnected")
    #expect(result.hosts.first { $0.host == refs["limited"] }?.state == "disconnected")
    #expect(result.hosts.first { $0.host == refs["changed"] }?.state == "disconnected")
    #expect(result.hosts.first { $0.host == refs["offline"] }?.state == "disconnected")
    #expect(result.hosts.first { $0.host == alias }?.state == "alias")
    let paths = UsageProjectionHTTP.paths
    #expect(paths.allSatisfy { $0.hasPrefix("local:") })
    #expect(!paths.contains { $0 == "old:GET:/api/usage-history/query" || $0 == "changed:GET:/api/usage-history/query" })
    #expect(paths.allSatisfy { $0.contains(":GET:") && ($0.hasSuffix("/api/hello") || $0.hasSuffix("/api/usage-history/query")) })
    let localRef = try #require(refs["local"])
    #expect(try hosts.localUsageToken(for: localRef).host == localRef)
    #expect(throws: HostRoutingError.identityChanged) { try hosts.localUsageToken(for: alias) }
    let secondLocal = HostRef(hostId: "local", daemonId: "replacement", lineageId: "lineage")
    let replacement = PilotClient(baseURL: URL(string: "http://replacement.usage.invalid"), commandConfiguration: configuration)
    replacement.loadFixture(projects: [], sessions: [])
    UsageProjectionHTTP.reset()
    #expect(throws: HostRoutingError.identityChanged) { try hosts.install(replacement, host: secondLocal) }
    #expect(throws: HostRoutingError.identityChanged) { try hosts.localUsageToken(for: secondLocal) }
    #expect(try hosts.localUsageToken(for: localRef).host == localRef)
    #expect(UsageProjectionHTTP.paths.isEmpty)
    await hosts.disconnect(localRef)
    UsageProjectionHTTP.reset()
    do {
        _ = try await hosts.localUsage(query)
        Issue.record("Missing Local must not fall back to a connected devbox or alias")
    } catch { #expect(error as? HostRoutingError == .disconnected) }
    #expect(UsageProjectionHTTP.paths.isEmpty)
    // Capability, capacity and identity failures still apply to the one Local endpoint.
    for (name, expected) in [("old", "unsupported"), ("failed", "unavailable"), ("limited", "limited"), ("changed", "unavailable")] {
        UsageProjectionHTTP.reset()
        let ref = HostRef(hostId: "local", daemonId: name, lineageId: "lineage")
        let client = PilotClient(baseURL: URL(string: "http://\(name).usage.invalid"), commandConfiguration: configuration)
        client.loadFixture(projects: [], sessions: [])
        try hosts.install(client, host: ref)
        let result = try await hosts.localUsage(query)
        #expect(result.hosts.count == 1)
        #expect(result.hosts.first?.state == expected)
        #expect(UsageProjectionHTTP.paths.allSatisfy { $0.hasPrefix("\(name):GET:") })
        if ["old", "changed"].contains(name) {
            #expect(!UsageProjectionHTTP.paths.contains { $0.hasSuffix("/api/usage-history/query") })
        }
        await hosts.disconnect(ref)
    }
    await hosts.disconnectAll()
    try? FileManager.default.removeItem(at: directory)
}
