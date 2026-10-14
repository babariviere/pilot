import Foundation
import Testing
@testable import Pilot

private final class MissionDeletionHTTPStub: URLProtocol {
    nonisolated(unsafe) static var requests: [(method: String, path: String)] = []

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "mission-deletion.invalid"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        Self.requests.append((request.httpMethod ?? "", url.path))
        let failed = url.lastPathComponent == "failed"
        let response = HTTPURLResponse(url: url, statusCode: failed ? 500 : 200, httpVersion: nil,
                                       headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((failed ? #"{"error":"Deletion failed"}"# : "{}").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test @MainActor func sharedMissionDeletionClearsOnlyItsSelectionAfterSuccess() async throws {
    #expect(URLProtocol.registerClass(MissionDeletionHTTPStub.self))
    defer { URLProtocol.unregisterClass(MissionDeletionHTTPStub.self) }
    MissionDeletionHTTPStub.requests = []
    let client = PilotClient(baseURL: URL(string: "http://mission-deletion.invalid"))
    let app = AppModel()
    app.selectedMissionId = "open"

    // Requesting or cancelling the window's confirmation never performs a write.
    app.pendingMissionDeletionId = "open"
    #expect(app.selectedMissionId == "open")
    #expect(MissionDeletionHTTPStub.requests.isEmpty)
    app.pendingMissionDeletionId = nil
    #expect(app.selectedMissionId == "open")
    #expect(MissionDeletionHTTPStub.requests.isEmpty)

    try await app.deleteMission("open", using: client)
    #expect(app.selectedMissionId == nil)

    // Deletion from a row must not disturb a different open mission, project or chat.
    app.selectedMissionId = "other"
    try await app.deleteMission("from-row", using: client)
    #expect(app.selectedMissionId == "other")
    app.selectedProjectId = "project"
    try await app.deleteMission("from-project", using: client)
    #expect(app.selectedProjectId == "project")
    app.selectedSessionId = "member-chat"
    try await app.deleteMission("from-sidebar", using: client)
    #expect(app.selectedSessionId == "member-chat")

    app.selectedSessionId = nil
    app.selectedMissionId = "failed"
    do {
        try await app.deleteMission("failed", using: client)
        Issue.record("Deletion should fail")
    } catch {
        #expect(error.localizedDescription == "Deletion failed")
    }
    #expect(app.selectedMissionId == "failed")
    #expect(MissionDeletionHTTPStub.requests.map(\.method) == Array(repeating: "DELETE", count: 5))
    #expect(MissionDeletionHTTPStub.requests.map(\.path) == [
        "/api/missions/open", "/api/missions/from-row", "/api/missions/from-project",
        "/api/missions/from-sidebar", "/api/missions/failed",
    ])
}
