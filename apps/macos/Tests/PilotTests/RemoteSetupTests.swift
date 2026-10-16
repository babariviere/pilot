import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class SetupHTTPStub: URLProtocol {
    struct Request: Sendable { let host: String; let path: String; let method: String }
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var requests: [Request] = []
        var loseStartReply = false
    }
    private static let state = State()
    static func reset(loseStartReply: Bool = false) {
        state.lock.lock(); defer { state.lock.unlock() }
        state.requests = []; state.loseStartReply = loseStartReply
    }
    static var requests: [Request] {
        state.lock.lock(); defer { state.lock.unlock() }; return state.requests
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix("setup.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!, method = request.httpMethod ?? "GET"
        Self.state.lock.lock()
        Self.state.requests.append(Request(host: url.host!, path: url.path, method: method))
        let loseReply = Self.state.loseStartReply
        Self.state.lock.unlock()
        if method == "POST", loseReply {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return
        }
        let run = """
        {"id":"same","provider":"anthropic","method":"manual_code","state":"\(method == "DELETE" ? "cancelled" : "waiting")",
        "createdAt":1,"expiresAt":300001,"reauthenticationRequired":\(method == "DELETE" ? "true" : "false")}
        """
        let body: String
        if url.path == "/api/setup" {
            body = "{\"providers\":[],\"integrations\":[],\"independentCredentials\":true}"
        } else if url.path.hasSuffix("/credential") {
            body = "{\"state\":\"missing\"}"
        } else if url.path == "/api/setup/runs", method == "GET" {
            body = "[\(run)]"
        } else { body = run }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor private func setupClient(_ name: String) -> PilotClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SetupHTTPStub.self]
    let client = PilotClient(baseURL: URL(string: "http://\(name).setup.invalid")!, commandConfiguration: configuration)
    client.loadFixture(projects: [], sessions: [])
    return client
}

@Suite(.serialized) struct RemoteSetupTests {
    private let local = HostRef(hostId: "local", daemonId: "local", lineageId: "l1")
    private let remote = HostRef(hostId: "box", daemonId: "remote", lineageId: "r1")

    @Test @MainActor func readinessLoginCancelLogoutAreHostScopedWithoutAnyProjectOrChat() async throws {
        SetupHTTPStub.reset()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory)
        try hosts.install(setupClient("local"), host: local)
        try hosts.install(setupClient("remote"), host: remote)
        let readiness = try await hosts.setupReadiness(on: remote)
        #expect(readiness.independentCredentials)
        let run = try await hosts.startSetup(on: remote, request: SetupStartRequest(provider: "anthropic", method: .manualCode))
        #expect(run.host == remote)
        let cancelled = try await hosts.cancelSetup(run)
        #expect(cancelled.run.reauthenticationRequired)
        #expect(cancelled.run.state == .cancelled)
        let logout = try await hosts.logoutSetupProvider("anthropic", on: remote)
        #expect(logout.state == .missing)
        #expect(SetupHTTPStub.requests.count == 4)
        #expect(SetupHTTPStub.requests.allSatisfy { $0.host == "remote.setup.invalid" })
        await hosts.disconnect(remote)
        do { _ = try await hosts.setupReadiness(on: remote); Issue.record("Offline setup must not target Local") } catch {}
        #expect(SetupHTTPStub.requests.count == 4)
    }

    @Test @MainActor func uncertainStartIsNotRepostedAndExistingRunCanBeFoundExplicitly() async throws {
        SetupHTTPStub.reset(loseStartReply: true)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hosts = HostClients(operationDirectory: directory)
        try hosts.install(setupClient("remote"), host: remote)
        do {
            _ = try await hosts.startSetup(on: remote, request: SetupStartRequest(provider: "anthropic", method: .manualCode))
            Issue.record("Fixture should lose the reply")
        } catch {}
        let runs = try await hosts.setupRuns(on: remote)
        #expect(runs.count == 1)
        #expect(runs.first?.host == remote)
        #expect(SetupHTTPStub.requests.filter { $0.method == "POST" }.count == 1)
        await hosts.disconnect(remote)
    }
}
