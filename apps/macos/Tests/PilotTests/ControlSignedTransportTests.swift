import Foundation
import PilotCore
import Testing
@testable import Pilot

/// Transport fixtures only, not daemon authentication or rollout evidence.
private final class ControlSignedHTTP: URLProtocol {
    struct Request: Sendable {
        let host: String
        let body: Data
        let proof: String?
        let signature: String?
        let ambientAuthorization: String?
    }
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var requests: [Request] = []
        var status = 200
    }
    private static let state = State()
    static func reset(status: Int = 200) {
        state.lock.lock(); defer { state.lock.unlock() }
        state.requests = []; state.status = status
    }
    static var requests: [Request] { state.lock.lock(); defer { state.lock.unlock() }; return state.requests }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".courier-http.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while body.count <= 2 * 1024 * 1024 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        Self.state.lock.lock()
        Self.state.requests.append(.init(host: request.url!.host!, body: body,
            proof: request.value(forHTTPHeaderField: "x-pilot-control-proof"),
            signature: request.value(forHTTPHeaderField: "x-pilot-control-signature"),
            ambientAuthorization: request.value(forHTTPHeaderField: "authorization")))
        let status = Self.state.status
        Self.state.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((status == 200 ? "{\"ok\":true}" : "{\"error\":\"Unknown route\",\"code\":\"not_found\"}").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized) struct ControlSignedTransportTests {
    @MainActor private func fixture() throws -> PilotClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ControlSignedHTTP.self]
        configuration.httpAdditionalHeaders = ["Authorization": "fixture-ambient-must-not-be-used"]
        let client = PilotClient(baseURL: URL(string: "http://box.courier-http.invalid"), commandConfiguration: configuration)
        try client.bind(HostRef(hostId: "box", daemonId: "executor", lineageId: "history"))
        client.loadFixture(projects: [], sessions: [])
        return client
    }
    private var authentication: ControlCourierAuthentication {
        .init(signedPayload: "opaque-fixture-proof", signature: Data(repeating: 0, count: 64).base64EncodedString())
    }

    @Test @MainActor func preservesSignedBodyBytesAndUsesOnlyTheExplicitEndpointAndHeaders() async throws {
        ControlSignedHTTP.reset()
        let client = try fixture()
        let body = Data("{\"second\":2,\n\"first\":\"é\"}".utf8)
        let value: JSONValue = try await client.controlRequest(path: "/api/control-hosts/fixture/enrollment", method: "POST", body: body, authentication: authentication)
        #expect(value["ok"]?.bool == true)
        let request = try #require(ControlSignedHTTP.requests.first)
        #expect(request.host == "box.courier-http.invalid" && request.body == body)
        #expect(request.proof == Data(authentication.signedPayload.utf8).base64EncodedString())
        #expect(request.signature == authentication.signature && request.ambientAuthorization == nil)
    }

    @Test @MainActor func unsupportedRouteIsPreciseAndNeverFallsBackOrRetries() async throws {
        ControlSignedHTTP.reset(status: 404)
        let client = try fixture()
        do {
            let _: JSONValue = try await client.controlRequest(path: "/api/control-hosts/fixture/sync-state", method: "GET", authentication: authentication)
            Issue.record("Unsupported route was accepted")
        } catch let error as ControlCourierFailure {
            #expect(error.kind == .incompatible && error.status == 404 && error.code == .notFound)
        }
        #expect(ControlSignedHTTP.requests.count == 1)
        #expect(ControlSignedHTTP.requests.allSatisfy { $0.host == "box.courier-http.invalid" })
    }

    @Test @MainActor func crossOriginAndOversizedRequestsNeverEnterTransport() async throws {
        ControlSignedHTTP.reset()
        let client = try fixture()
        for (path, body) in [("//local.courier-http.invalid/api/control-hosts", Data()),
                             ("/api/control-hosts/fixture/enrollment", Data(repeating: 0, count: 2 * 1024 * 1024 + 1))] {
            do {
                let _: JSONValue = try await client.controlRequest(path: path, method: "POST", body: body, authentication: authentication)
                Issue.record("Unsafe request entered transport")
            } catch {}
        }
        #expect(ControlSignedHTTP.requests.isEmpty)
    }
}
