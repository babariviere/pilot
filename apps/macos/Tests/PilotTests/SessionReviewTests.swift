import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class ReviewHTTPStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "session-reviews.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        let expected = ReviewRequest(marks: [.init(sessionId: "s", outcomeAt: 123)])
        let valid = request.httpMethod == "POST" && request.url?.path == "/api/reviews"
            && request.value(forHTTPHeaderField: "Content-Type") == "application/json"
            && (try? JSONDecoder().decode(ReviewRequest.self, from: data)) == expected
        let response = HTTPURLResponse(url: request.url!, statusCode: valid ? 200 : 400,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let body = valid ? #"{"ok":true}"# : #"{"error":"Invalid review request"}"#
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test @MainActor func reviewCommandPostsProtocolMarksAndLeavesSessionOutcomeUnchanged() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ReviewHTTPStub.self]
    let client = PilotClient(baseURL: URL(string: "http://session-reviews.invalid"), commandConfiguration: configuration)
    let session = SessionSummary(id: "s", title: "Chat", cwd: "/tmp", createdAt: 1, updatedAt: 200,
                                 state: "idle", outcome: .done, outcomeAt: 123)
    client.loadFixture(projects: [], sessions: [session])
    try await client.review(ReviewRequest(marks: [.init(sessionId: "s", outcomeAt: 123)]))
    #expect(client.session("s") == session)
    do {
        let oversized = ReviewRequest(marks: Array(repeating: .init(sessionId: "s", outcomeAt: 123), count: 1001))
        try await client.review(oversized)
        Issue.record("Expected the client to enforce the daemon's request limit")
    } catch {
        #expect(error.localizedDescription == "Too many review marks")
    }
    do {
        try await client.review(ReviewRequest(marks: [.init(sessionId: "s", outcomeAt: 124)]))
        Issue.record("Expected the HTTP error to propagate so the forwarder can retry")
    } catch {
        #expect(error.localizedDescription == "Invalid review request")
    }
}
