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

@MainActor private func stopEventually(_ predicate: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !predicate() {
        guard ContinuousClock.now < deadline else { throw ClientError("Stop fixture timed out") }
        try await Task.sleep(for: .milliseconds(5))
    }
}

@Test(arguments: [false, true]) @MainActor
func localStopNormalizesQualifiedRowsAndRestoresWithdrawnMessages(qualified: Bool) async throws {
    let app = AppModel(client: stopClient("local"))
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    try app.registerLocal(local)
    let ref = HostResourceRef(host: local, kind: .session, localId: "same")
    let composer = app.composer(for: "same")
    composer.draft = "newer draft"

    app.stopSession(qualified ? ref.storageKey : ref.localId)
    #expect(app.pendingSessionActions == [ref.localId])
    // A second entry point for the same Local chat must not issue another Stop.
    app.stopSession(qualified ? ref.localId : ref.storageKey)
    try await stopEventually { app.pendingSessionActions.isEmpty }
    #expect(app.sessionActionError == nil)
    #expect(composer.draft == "local withdrawn\n\nnewer draft")
    #expect(try app.composer(for: ref) === composer)
}

@Test @MainActor func remoteStopKeepsCollidingLocalChatAndDraftUntouched() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let app = AppModel(client: stopClient("local"))
    let local = HostRef(hostId: "local", daemonId: "a", lineageId: "1")
    let remote = HostRef(hostId: "box", daemonId: "b", lineageId: "2")
    try app.registerLocal(local)
    try await app.hosts.restoreOffline(from: OfflineHostStore(directory: directory))
    try await app.hosts.enroll(remote, configuration: SSHConnectionConfiguration(alias: "fixture-box"))
    try app.hosts.install(stopClient("remote"), host: remote)
    let ref = HostResourceRef(host: remote, kind: .session, localId: "same")
    let remoteComposer = try app.composer(for: ref)
    remoteComposer.draft = "remote draft"
    app.composer(for: "same").draft = "local draft"

    app.stopSession(ref.storageKey)
    try await stopEventually { remoteComposer.draft != "remote draft" || app.sessionActionError != nil }
    #expect(app.sessionActionError == nil)
    #expect(remoteComposer.draft == "remote withdrawn\n\nremote draft")
    #expect(app.composer(for: "same").draft == "local draft")
    #expect(app.hosts.offlineHosts[remote]?.stopRequests["same"] == .acknowledged)
    #expect(app.client.session("same")?.state == "working")
}

@Test(arguments: ["box", "local"]) @MainActor
func unavailableStopNeverFallsBackToCurrentLocalHost(hostId: String) async throws {
    let app = AppModel(client: stopClient("local"))
    try app.registerLocal(HostRef(hostId: "local", daemonId: "a", lineageId: "1"))
    // Also cover an old Local installation whose pinned identity no longer matches.
    let unavailable = HostRef(hostId: hostId, daemonId: "other", lineageId: "other")
    let ref = HostResourceRef(host: unavailable, kind: .session, localId: "same")
    let composer = try app.composer(for: ref)
    composer.draft = "unavailable draft"
    app.composer(for: "same").draft = "local draft"
    app.stopSession(ref.storageKey)
    try await stopEventually { app.sessionActionError != nil }
    #expect(app.sessionActionError?.contains("Disconnected") == true)
    #expect(composer.draft == "unavailable draft")
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
        app.stopSession(key)
        #expect(app.sessionActionError == HostRoutingError.invalidReference.localizedDescription)
        #expect(app.pendingSessionActions.isEmpty)
    }
}
