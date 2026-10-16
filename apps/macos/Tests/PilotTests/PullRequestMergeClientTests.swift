import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class MergeHTTPStub: URLProtocol {
    nonisolated(unsafe) static var requests: [URLRequest] = []
    nonisolated(unsafe) static var denyMerge = false

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "pr-merge.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var recorded = request
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            recorded.httpBody = data
        }
        Self.requests.append(recorded)
        let preview = request.url!.path.hasSuffix("merge-preview")
        let status = !preview && Self.denyMerge ? 409 : 200
        let body = preview
            ? #"{"url":"https://github.com/o/r/pull/42","number":42,"title":"Fix export","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headBranch":"fix/export","baseBranch":"main","methods":["squash","merge"]}"#
            : status == 200 ? #"{"merged":true}"# : #"{"error":"Required checks pending"}"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                             headerFields: ["content-type": "application/json"])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Test @MainActor func mergeClientSendsOnlyConfirmedDataAndSurfacesGitHubFailures() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MergeHTTPStub.self]
    MergeHTTPStub.requests = []
    MergeHTTPStub.denyMerge = false
    defer { MergeHTTPStub.requests = []; MergeHTTPStub.denyMerge = false }
    let client = PilotClient(baseURL: URL(string: "http://pr-merge.invalid"), commandConfiguration: configuration)
    let url = "https://github.com/o/r/pull/42"
    let preview = try await client.previewPullRequestMerge("s", url: url)
    #expect(MergeHTTPStub.requests.count == 1, "opening confirmation never merges")
    try await client.mergePullRequest("s", preview: preview, method: .merge)
    #expect(MergeHTTPStub.requests.map { $0.httpMethod } == ["POST", "POST"])
    #expect(MergeHTTPStub.requests.map { $0.url!.path } == ["/api/sessions/s/pull-requests/merge-preview",
                                                           "/api/sessions/s/pull-requests/merge"])
    let bodyData = try #require(MergeHTTPStub.requests.last?.httpBody)
    let body = try JSONDecoder().decode([String: String].self, from: bodyData)
    #expect(body == ["url": url, "headSha": preview.headSha, "baseBranch": "main", "method": "merge"])
    MergeHTTPStub.denyMerge = true
    do {
        try await client.mergePullRequest("s", preview: preview, method: .squash)
        Issue.record("Expected GitHub's refusal")
    } catch {
        #expect(error.localizedDescription == "Required checks pending")
    }
    #expect(MergeHTTPStub.requests.count == 3, "a merge failure is never retried automatically")
}
