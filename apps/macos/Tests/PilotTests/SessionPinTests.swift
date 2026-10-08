import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class PinHTTPStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "session-pins.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let valid = request.httpMethod == "POST" && request.httpBody == nil && request.httpBodyStream == nil
        let action = url.lastPathComponent
        let status = valid && ["pin", "unpin"].contains(action) && url.path == "/api/sessions/s/\(action)" ? 200 : 400
        let body = status == 200 ? """
            {"id":"s","title":"Chat","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"working"\(action == "pin" ? ",\"pinned\":true" : "")}
            """ : #"{"error":"Expected a bodyless POST"}"#
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test @MainActor func pinCommandsPostWithoutBodyAndUpdateWorkingSummary() async throws {
    #expect(URLProtocol.registerClass(PinHTTPStub.self))
    defer { URLProtocol.unregisterClass(PinHTTPStub.self) }
    let client = PilotClient(baseURL: URL(string: "http://session-pins.invalid"))
    let recent = SessionSummary(id: "recent", title: "Recent", cwd: "/tmp", createdAt: 1, updatedAt: 100, state: "working")
    let old = SessionSummary(id: "s", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "working")
    client.loadFixture(projects: [], sessions: [old, recent])
    let pinned = try await client.pin("s")
    #expect(pinned.isPinned)
    #expect(pinned.isWorking)
    #expect(client.sessions == [pinned, recent])
    let unpinned = try await client.unpin("s")
    #expect(unpinned.pinned == nil)
    #expect(!unpinned.isPinned)
    #expect(client.sessions == [recent, unpinned])
}

@Test @MainActor func pinActionsRespectPendingGuardAndReportErrorsWithoutChangingSummary() async throws {
    let suite = "SessionPinTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(projectFolderDefaults: defaults)
    let session = SessionSummary(id: "s", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 2, state: "working")
    model.client.loadFixture(projects: [], sessions: [session])
    model.pendingSessionActions.insert(session.id)
    model.setPinned(true, sessionId: session.id)
    #expect(model.sessionActionError == nil)
    #expect(model.client.session(session.id) == session)
    model.pendingSessionActions.remove(session.id)
    model.setPinned(true, sessionId: session.id)
    #expect(model.pendingSessionActions.contains(session.id))
    for _ in 0..<100 {
        if !model.pendingSessionActions.contains(session.id) { break }
        await Task.yield()
    }
    #expect(!model.pendingSessionActions.contains(session.id))
    #expect(model.sessionActionError == "pilotd is not connected")
    #expect(model.client.session(session.id) == session)
}
