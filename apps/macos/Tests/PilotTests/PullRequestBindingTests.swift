import AppKit
import Foundation
import SwiftUI
import Testing
@testable import Pilot
@testable import PilotCore

/// Records binding requests and answers like pilotd: a summary on success, `{error}` otherwise.
private final class BindingHTTPStub: URLProtocol {
    nonisolated(unsafe) static var requests: [(method: String, path: String, body: [String: String])] = []

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "pull-request-bindings.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let data = request.httpBody ?? request.httpBodyStream.map { stream in
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            return data
        } ?? Data()
        let body = (try? JSONSerialization.jsonObject(with: data) as? [String: String]) ?? [:]
        let method = request.httpMethod ?? "GET"
        Self.requests.append((method, url.path, body))
        let bound = method == "POST"
        let status: Int
        let response: String
        if body["url"]?.contains("other/repo") == true {
            status = 400
            response = #"{"error":"The pull request must belong to the chat's project repository"}"#
        } else {
            status = 200
            response = """
                {"id":"s","title":"Chat","cwd":"/tmp","projectId":"p","createdAt":1,"updatedAt":\(bound ? 3 : 4),"state":"idle"\(bound ? #","boundPullRequests":["https://github.com/octo/repo/pull/42"]"# : "")}
                """
        }
        let http = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                                   headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test @MainActor func bindAndUnbindCallThePullRequestRouteAndUpdateTheChat() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [BindingHTTPStub.self]
    BindingHTTPStub.requests = []
    let client = PilotClient(baseURL: URL(string: "http://pull-request-bindings.invalid"), commandConfiguration: configuration)
    let session = SessionSummary(id: "s", title: "Chat", cwd: "/tmp", projectId: "p", createdAt: 1, updatedAt: 2, state: "idle")
    client.loadFixture(projects: [], sessions: [session])

    let url = "https://github.com/octo/repo/pull/42"
    let bound = try await client.bindPullRequest("s", url: url, taskId: "t34")
    #expect(bound.boundPullRequests == [url])
    #expect(client.session("s")?.isBoundPullRequest(url) == true)

    try await client.bindPullRequest("s", url: url)
    let unbound = try await client.unbindPullRequest("s", url: url)
    #expect(unbound.boundPullRequests == nil)
    #expect(client.session("s")?.boundPullRequests == nil)

    let requests = BindingHTTPStub.requests
    #expect(requests.map(\.method) == ["POST", "POST", "DELETE"])
    #expect(requests.allSatisfy { $0.path == "/api/sessions/s/pull-requests" })
    #expect(requests.map(\.body) == [["url": url, "taskId": "t34"], ["url": url], ["url": url]])

    // Daemon validation errors reach the popover verbatim, and the summary stays as it was.
    await #expect(throws: ClientError.self) {
        try await client.bindPullRequest("s", url: "https://github.com/other/repo/pull/1")
    }
    do {
        try await client.bindPullRequest("s", url: "https://github.com/other/repo/pull/1")
    } catch {
        #expect(error.localizedDescription == "The pull request must belong to the chat's project repository")
    }
    #expect(client.session("s") == unbound)
}

@MainActor private func contextHeight(_ session: SessionSummary, width: CGFloat = 316) throws -> Int {
    let renderer = ImageRenderer(content: ChangesRepositoryContext(session: session))
    renderer.proposedSize = ProposedViewSize(width: width, height: nil)
    let image = try #require(renderer.cgImage)
    #expect(image.width <= Int(width) + 1)
    return image.height
}

@Test @MainActor func changesContextShowsAttachedAndPendingPullRequestsWithTheAttachControl() throws {
    let own = SessionPullRequest(number: 7, url: "https://github.com/octo/repo/pull/7", title: "Own change",
                                 state: .open, checkedAt: 1, branch: "feat/own")
    let attached = SessionPullRequest(number: 42, url: "https://github.com/octo/repo/pull/42", title: "Handed off",
                                      state: .open, checkedAt: 1, branch: "external/fix")
    func session(prs: [SessionPullRequest], bound: [String]? = nil, mode: ChatMode? = nil,
                 project: String? = "p") -> SessionSummary {
        SessionSummary(id: "context", title: "Chat", cwd: "/repository", projectId: project, branch: "feat/own",
                       createdAt: 1, updatedAt: 1, state: "idle", pullRequest: prs.first, pullRequests: prs,
                       boundPullRequests: bound, mode: mode, workspaceStorage: .shared,
                       branches: Array(Set(prs.compactMap(\.branch) + ["feat/own"])).sorted())
    }
    let discovered = session(prs: [own])
    let withAttached = session(prs: [own, attached], bound: [attached.url])
    let pending = session(prs: [own], bound: [attached.url])
    // The attach control is a row of its own, absent where attaching is not possible.
    #expect(try contextHeight(discovered) > contextHeight(session(prs: [own], project: nil)))
    #expect(try contextHeight(discovered) > contextHeight(session(prs: [own], mode: .ask)))
    #expect(try contextHeight(withAttached) > contextHeight(discovered), "the attached PR gets its own branch row")
    #expect(try contextHeight(pending) > contextHeight(discovered), "a bound PR shows before GitHub details arrive")
    #expect(withAttached.showsAttachedHint(attached, current: "feat/own"))
    #expect(!withAttached.showsAttachedHint(own, current: "feat/own"))
}

@Test @MainActor func attachPopoverRendersSuggestionsTasksAndErrors() throws {
    let session = SessionSummary(id: "attach-form", title: "Chat", cwd: "/repository", projectId: "p",
                                 createdAt: 1, updatedAt: 1, state: "idle", missionId: "m")
    let mission = MissionDetail(
        mission: Mission(id: "m", projectId: "p", title: "M", goal: "g", createdAt: 1, updatedAt: 1),
        brief: nil, decisions: [], decisionProposals: [], comments: [],
        tasks: [MissionTask(id: "t", number: 34, title: "Mine", status: .inProgress, sessionId: "attach-form")],
        artifacts: [], resources: [], events: [])
    func height(_ draft: PullRequestAttachDraft, mission: MissionDetail? = nil) throws -> Int {
        let renderer = ImageRenderer(content: AttachPullRequestForm(session: session, draft: draft, mission: mission) {})
        let image = try #require(renderer.cgImage)
        #expect(image.width >= 360)
        return image.height
    }
    let empty = try height(PullRequestAttachDraft())
    var failed = PullRequestAttachDraft(text: "https://github.com/other/repo/pull/1")
    failed.error = "The pull request must belong to the chat's project repository"
    #expect(try height(failed) > empty, "daemon errors show inline")
    #expect(try height(PullRequestAttachDraft(text: "not a link")) > empty, "invalid links get a hint")
    #expect(try height(PullRequestAttachDraft(taskId: "t"), mission: mission) > empty, "mission chats pick a task")
}
