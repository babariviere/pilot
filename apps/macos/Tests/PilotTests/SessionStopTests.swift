import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class StopHTTPStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        ["local-session-stop.invalid", "remote-session-stop.invalid"].contains(request.url?.host ?? "")
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let valid = request.httpMethod == "POST" && url.path == "/api/sessions/same/stop"
        let owner = url.host == "local-session-stop.invalid" ? "local" : "remote"
        let body = valid ? #"{"ok":true,"draft":"\#(owner) withdrawn"}"#
            : #"{"error":"Unexpected stop destination"}"#
        let response = HTTPURLResponse(url: url, statusCode: valid ? 200 : 400, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor private func stopClient(_ owner: String) -> PilotClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StopHTTPStub.self]
    let client = PilotClient(baseURL: URL(string: "http://\(owner)-session-stop.invalid/")!,
        commandConfiguration: configuration)
    client.loadFixture(projects: [], sessions: [
        SessionSummary(id: "same", title: owner, cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "working"),
    ])
    return client
}

@Test(.timeLimit(.minutes(2)), arguments: [false, true]) @MainActor
func localStopNormalizesQualifiedRowsAndRestoresWithdrawnMessages(qualified: Bool) async throws {
    let app = AppModel(client: stopClient("local"))
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    try app.registerLocal(local)
    try app.hosts.install(app.client, host: local)
    let ref = HostResourceRef(host: local, kind: .session, localId: "same")
    let composer = app.composer(for: "same")
    composer.draft = "newer draft"

    let stop = try #require(app.stopSession(qualified ? ref.storageKey : ref.localId))
    #expect(app.pendingSessionActions == [ref.localId])
    // A second entry point for the same Local chat must not issue another Stop.
    #expect(app.stopSession(qualified ? ref.localId : ref.storageKey) == nil)
    await stop.value
    #expect(app.pendingSessionActions.isEmpty)
    #expect(app.sessionActionError == nil)
    #expect(composer.draft == "local withdrawn\n\nnewer draft")
    #expect(try app.composer(for: ref) === composer)
}

@Test(.timeLimit(.minutes(2)), arguments: ["box", "local"]) @MainActor
func unavailableStopNeverFallsBackToCurrentLocalHost(hostId: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let app = AppModel(client: stopClient("local"), hosts: ClientDirectory(operationDirectory: directory))
    try app.registerLocal(HostRef(hostId: "local", daemonId: "a", lineageId: "1"))
    let local = try #require(app.localHost)
    try app.hosts.install(app.client, host: local)
    // Also cover an old Local installation whose pinned identity no longer matches.
    let unavailable = HostRef(hostId: hostId, daemonId: "other", lineageId: "other")
    let ref = HostResourceRef(host: unavailable, kind: .session, localId: "same")
    // A disconnected target retains its admitted inventory. A completely unknown
    // target is rejected by canMutateSession before any asynchronous Stop dispatch.
    try loadClientFixture(stopClient("remote"), host: unavailable, into: app.hosts)
    await app.hosts.disconnect(unavailable)
    try #require(app.hosts.sessions.contains { $0.ref == ref })
    #expect(!app.hosts.available.contains(unavailable))
    #expect(app.hosts.localHost == app.localHost)
    #expect(app.hosts.available.contains(local))
    let composer = try app.composer(for: ref)
    composer.draft = "unavailable draft"
    app.composer(for: "same").draft = "local draft"
    #expect(app.stopSession(ref.storageKey) == nil)
    #expect(app.sessionActionError == nil)
    #expect(composer.draft == "unavailable draft")
    #expect(app.composer(for: "same").draft == "local draft")
    #expect(app.pendingSessionActions.isEmpty)
    await app.hosts.disconnectAll()
}

@Test(.timeLimit(.minutes(2)), arguments: ["box", "local"]) @MainActor
func unknownStopIsRejectedBeforeDispatchWithoutLocalFallback(hostId: String) throws {
    let app = AppModel(client: stopClient("local"))
    try app.registerLocal(HostRef(hostId: "local", daemonId: "a", lineageId: "1"))
    let ref = HostResourceRef(host: HostRef(hostId: hostId, daemonId: "unknown", lineageId: "unknown"),
        kind: .session, localId: "same")
    let composer = try app.composer(for: ref)
    composer.draft = "unknown draft"
    app.composer(for: "same").draft = "local draft"
    #expect(app.stopSession(ref.storageKey) == nil)
    #expect(app.sessionActionError == nil)
    #expect(composer.draft == "unknown draft")
    #expect(app.composer(for: "same").draft == "local draft")
    #expect(app.pendingSessionActions.isEmpty)
}

@Test @MainActor func stopRejectsMalformedAndNonSessionReferencesBeforeDispatch() throws {
    let app = AppModel(client: stopClient("local"))
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    try app.registerLocal(local)
    let keys = ["hostref1:invalid", HostResourceRef(host: local, kind: .project, localId: "same").storageKey,
        HostResourceRef(host: local, kind: .mission, localId: "same").storageKey]
    for key in keys {
        app.sessionActionError = nil
        #expect(app.stopSession(key) == nil)
        #expect(app.sessionActionError == HostRoutingError.invalidReference.localizedDescription)
        #expect(app.pendingSessionActions.isEmpty)
    }
}
