import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class RepositoryHTTPStub: URLProtocol {
    private static let lock = NSLock()
    private static var requests: [String: Int] = [:]

    static func count(_ host: String, path: String) -> Int {
        lock.withLock { requests[host + path, default: 0] }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        Self.lock.withLock { Self.requests[url.host! + url.path, default: 0] += 1 }
        let full = url.path == "/api/sessions/task/changes"
        let branch = url.path == "/api/sessions/task/changes/branch"
        let success = (full || branch || url.path == "/api/sessions/task/changes/summary") && url.host != "failed.invalid"
        let response = HTTPURLResponse(url: url, statusCode: success ? 200 : 404, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        let body = success
            ? (branch ? #"{"branch":"pilot/task"}"# : full ? #"{"base":"HEAD","files":[],"diff":"","truncated":false}"#
                    : #"{"base":"origin/main","branch":"pilot/task","fileCount":3,"additions":13,"deletions":2}"#)
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

@Test @MainActor func sidebarPollsOnlyBranchesAndLoadsCountsOnDemand() async {
    let host = "\(UUID().uuidString.lowercased()).invalid"
    let client = repositoryClient(host)
    let model = SessionRepositoryModel()
    await model.loadBranch(repositorySession(), client: client)
    await model.loadBranch(repositorySession(), client: client)
    #expect(model.branch(for: repositorySession()) == "pilot/task")
    #expect(model.summary == nil)
    #expect(RepositoryHTTPStub.count(host, path: "/api/sessions/task/changes/branch") == 1)
    #expect(RepositoryHTTPStub.count(host, path: "/api/sessions/task/changes/summary") == 0)
    await model.load(repositorySession(), client: client)
    #expect(model.summary?.fileCount == 3)
    #expect(RepositoryHTTPStub.count(host, path: "/api/sessions/task/changes/summary") == 1)
    model.clearSummary()
    #expect(model.summary == nil)
    #expect(model.branch(for: repositorySession()) == "pilot/task")
    client.refreshRepositoryCaches()
    await model.loadBranch(repositorySession(), client: client)
    #expect(RepositoryHTTPStub.count(host, path: "/api/sessions/task/changes/branch") == 2)
    client.handle(.session(SessionSummary(id: "task", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 3, state: "idle")))
    await model.loadBranch(repositorySession(), client: client)
    #expect(RepositoryHTTPStub.count(host, path: "/api/sessions/task/changes/branch") == 3)
}

@Test @MainActor func branchRefreshHandlesDetachedHeadsErrorsAndStartingWorkspaces() async {
    let client = PilotClient()
    let model = SessionRepositoryModel()
    client.fixtureChangeSummaries["task"] = SessionChangeSummary(base: "HEAD", fileCount: 0)
    await model.loadBranch(repositorySession("starting"), client: client)
    #expect(model.branchSnapshot == nil)
    await model.loadBranch(repositorySession(), client: client)
    #expect(model.branchSnapshot == SessionBranch())
    #expect(model.branch(for: repositorySession()) == nil)
    await model.loadBranch(repositorySession(), client: repositoryClient("failed.invalid"))
    #expect(model.branchSnapshot == nil)
    #expect(model.error == "Not a git repository")
}

@Test @MainActor func branchSuccessDoesNotHideADiffSummaryError() async {
    let model = SessionRepositoryModel()
    await model.load(repositorySession(), client: repositoryClient("failed.invalid"))
    await model.loadBranch(repositorySession(), client: repositoryClient())
    #expect(model.error == "Not a git repository")
    model.clearSummary()
    #expect(model.error == nil)
}

@Test @MainActor func cancelledBranchRefreshDoesNotPublish() async {
    let client = PilotClient()
    client.fixtureChangeSummaries["task"] = SessionChangeSummary(base: "HEAD", branch: "fix/new", fileCount: 0)
    let model = SessionRepositoryModel()
    let refresh = Task { @MainActor in
        await Task.yield()
        await model.loadBranch(repositorySession(), client: client)
    }
    refresh.cancel()
    await refresh.value
    #expect(model.branchSnapshot == nil && model.summary == nil && model.error == nil)
}

@Test @MainActor func fullDiffReadsCoalesceAndActivityInvalidatesTheirCache() async throws {
    let host = "\(UUID().uuidString.lowercased()).invalid"
    let path = "/api/sessions/task/changes"
    let client = repositoryClient(host)
    client.handle(.sessions([repositorySession()]))
    async let first = client.changes("task")
    async let second = client.changes("task")
    let (a, b) = try await (first, second)
    #expect(a == b)
    #expect(RepositoryHTTPStub.count(host, path: path) == 1)
    let session = SessionSummary(id: "task", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 3, state: "idle")
    client.handle(.session(session))
    _ = try await client.changes("task")
    #expect(RepositoryHTTPStub.count(host, path: path) == 2)
}

@Test @MainActor func returningToWindowBypassesCompletedRepositoryValues() async throws {
    let host = "\(UUID().uuidString.lowercased()).invalid"
    let client = repositoryClient(host)
    _ = try await client.changeSummary("task")
    _ = try await client.changes("task")
    client.refreshRepositoryCaches()
    _ = try await client.changeSummary("task")
    _ = try await client.changes("task")
    #expect(RepositoryHTTPStub.count(host, path: "/api/sessions/task/changes/summary") == 2)
    #expect(RepositoryHTTPStub.count(host, path: "/api/sessions/task/changes") == 2)
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
