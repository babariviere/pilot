import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class RepositoryHTTPStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let success = url.path == "/api/sessions/task/changes/summary" && url.host != "failed.invalid"
        let response = HTTPURLResponse(url: url, statusCode: success ? 200 : 404, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        let body = success
            ? #"{"base":"origin/main","branch":"pilot/task","fileCount":3,"additions":13,"deletions":2}"#
            : #"{"error":"Not a git repository"}"#
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor private func repositoryClient(_ host: String = "repository.invalid") -> PilotClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RepositoryHTTPStub.self]
    return PilotClient(baseURL: URL(string: "http://\(host)"), artifactSession: URLSession(configuration: configuration))
}

private func repositorySession(_ state: String = "idle") -> SessionSummary {
    SessionSummary(id: "task", title: "Task", cwd: "/tmp", branch: "pilot/task", createdAt: 1, updatedAt: 2, state: state)
}

@Test @MainActor func sidebarLoadsSummaryWithoutNeedingAPullRequest() async throws {
    let client = repositoryClient()
    let model = SessionRepositoryModel()
    await model.load(repositorySession(), client: client)
    #expect(model.summary == SessionChangeSummary(base: "origin/main", branch: "pilot/task", fileCount: 3, additions: 13, deletions: 2))
    #expect(model.error == nil)
}

@Test @MainActor func sidebarDoesNotShowZeroOrStaleCountAfterAnError() async {
    let model = SessionRepositoryModel()
    await model.load(repositorySession(), client: repositoryClient())
    #expect(model.summary != nil)
    await model.load(repositorySession(), client: repositoryClient("failed.invalid"))
    #expect(model.summary == nil)
    #expect(model.error == "Not a git repository")
}

@Test @MainActor func sidebarWaitsForWorkspaceAndRefreshesAfterStarting() async {
    let model = SessionRepositoryModel()
    let client = repositoryClient()
    await model.load(repositorySession("starting"), client: client)
    #expect(model.summary == nil)
    #expect(model.error == nil)
    await model.load(repositorySession("working"), client: client)
    #expect(model.summary?.fileCount == 3)
}

@Test @MainActor func sidebarFixturesCanRefreshToZeroChanges() async {
    let client = PilotClient()
    let model = SessionRepositoryModel()
    client.fixtureChangeSummaries["task"] = SessionChangeSummary(base: "HEAD", fileCount: 1)
    await model.load(repositorySession(), client: client)
    #expect(model.summary?.fileCountLabel == "1 file")
    client.fixtureChangeSummaries["task"] = SessionChangeSummary(base: "HEAD", fileCount: 0)
    await model.load(repositorySession(), client: client)
    #expect(model.summary?.fileCountLabel == "0 files")
}

@Test @MainActor func sidebarUsesFallbackBranchOnlyUntilSummaryArrives() async {
    let client = PilotClient()
    let model = SessionRepositoryModel()
    #expect(model.branch(for: repositorySession()) == "pilot/task")
    client.fixtureChangeSummaries["task"] = SessionChangeSummary(base: "HEAD", fileCount: 0)
    await model.load(repositorySession(), client: client)
    #expect(model.branch(for: repositorySession()) == nil) // Successfully read a detached HEAD.
}

@Test @MainActor func repositoryRequestsAreBoundedAndReleaseCancelledSlots() async throws {
    let limiter = RepositoryRequestLimiter(limit: 1)
    var release: CheckedContinuation<Void, Never>?
    let first = Task { @MainActor in
        try await limiter.perform {
            await withCheckedContinuation { release = $0 }
        }
    }
    while release == nil { await Task.yield() }
    var secondStarted = false
    let second = Task { @MainActor in
        try await limiter.perform { secondStarted = true }
    }
    await Task.yield()
    #expect(!secondStarted)
    second.cancel()
    release?.resume()
    try await first.value
    do {
        try await second.value
        Issue.record("Cancelled queued requests must not run")
    } catch is CancellationError {}
    #expect(!secondStarted)
    let next = try await limiter.perform { 42 }
    #expect(next == 42)
}

@Test @MainActor func cancelledSidebarRefreshDoesNotPublishItsResult() async {
    let client = PilotClient()
    let model = SessionRepositoryModel()
    client.fixtureChangeSummaries["task"] = SessionChangeSummary(base: "HEAD", fileCount: 1)
    let refresh = Task { @MainActor in
        // Yield so the caller can cancel before reading the synchronous fixture.
        await Task.yield()
        await model.load(repositorySession(), client: client)
    }
    refresh.cancel()
    await refresh.value
    #expect(model.summary == nil)
    #expect(model.error == nil)
}
