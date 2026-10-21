import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class DiagnosticReadHTTP: URLProtocol {
    struct Seen: Sendable { let host: String; let path: String; let capability: String?; let body: JSONValue }
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var continuation: AsyncStream<Seen>.Continuation?
        var wrongIdentity = false
    }
    private static let state = State()
    static func stream(wrongIdentity: Bool = false) -> AsyncStream<Seen> {
        AsyncStream { continuation in
            state.lock.lock(); defer { state.lock.unlock() }
            state.continuation = continuation; state.wrongIdentity = wrongIdentity
        }
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".diagnostic.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, let name = url.host?.components(separatedBy: ".").first else { return }
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while data.count <= 65536 {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        Self.state.lock.lock()
        let continuation = Self.state.continuation, wrong = Self.state.wrongIdentity
        Self.state.lock.unlock()
        let body = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        let seen = Seen(host: name, path: url.path, capability: request.value(forHTTPHeaderField: "x-pilot-github-capability"), body: body)
        let response: [String: Any] = url.path.hasSuffix("read-response") ? ["accepted": true] : [
            "schemaVersion": 1, "host": ["hostId": name, "daemonId": "daemon-\(name)", "lineageId": wrong ? "replaced" : "lineage-\(name)"],
            "collectedAt": "2026-10-19T00:00:00.000Z", "status": "available", "data": ["chats": []],
            "page": ["more": false, "scanned": 0, "maxScan": 200, "maxBytes": 65536, "truncated": false]
        ]
        do {
            let bytes = try JSONSerialization.data(withJSONObject: response)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: bytes)
            client?.urlProtocolDidFinishLoading(self)
            continuation?.yield(seen)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@Suite(.serialized) struct DiagnosticContextTransportTests {
    @Test @MainActor func verifiedReadCourierUsesOnlyExistingEndpointsAndRejectsWrongLineage() async throws {
        for wrong in [false, true] {
            let stream = DiagnosticReadHTTP.stream(wrongIdentity: wrong)
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let hosts = HostClients(operationDirectory: directory, readNativeCapability: { host, _ in "fixture-\(host.hostId)" })
            func endpoint(_ name: String) throws -> (PilotClient, HostRef) {
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [DiagnosticReadHTTP.self]
                let client = PilotClient(baseURL: URL(string: "http://\(name).diagnostic.invalid"), commandConfiguration: configuration)
                let host = HostRef(hostId: name, daemonId: "daemon-\(name)", lineageId: "lineage-\(name)")
                try client.bind(host); client.loadFixture(projects: [], sessions: [])
                return (client, host)
            }
            let (local, localHost) = try endpoint("local"), (remote, remoteHost) = try endpoint("remote")
            let inventory = OfflineHostStore(directory: directory.appendingPathComponent("hosts"))
            try await inventory.save([OfflineHostSnapshot(host: remoteHost,
                configuration: try SSHConnectionConfiguration(alias: "fixture-remote"))])
            try await hosts.restoreOffline(from: inventory)
            try hosts.install(local, host: localHost); try hosts.install(remote, host: remoteHost)
            let bytes = try JSONSerialization.data(withJSONObject: ["id": UUID().uuidString,
                "request": ["action": "chats", "host": ["hostId": "remote", "daemonId": "daemon-remote", "lineageId": "lineage-remote"]]])
            let dispatch = try JSONDecoder().decode(DiagnosticReadDispatch.self, from: bytes)
            local.onDiagnosticRead?(dispatch); local.onDiagnosticRead?(dispatch)
            var seen: [DiagnosticReadHTTP.Seen] = []
            for await request in stream {
                seen.append(request)
                if request.path.hasSuffix("read-response") { break }
            }
            #expect(seen.map(\.host) == ["remote", "local"], "duplicate activation admits only one read")
            #expect(seen.allSatisfy { $0.capability == "fixture-\($0.host)" })
            let reply = try #require(seen.last?.body["result"])
            #expect(reply["status"]?.string == (wrong ? "unavailable" : "available"))
            if wrong { #expect(reply["data"] == nil) }
            await hosts.disconnectAll()
        }
    }
}
