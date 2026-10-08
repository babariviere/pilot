import Foundation
import PilotCore
import Testing
@testable import Pilot

/// Per-request fixtures keep concurrently running tests independent.
private final class ArtifactHTTPStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        var status = 200
        let body: String
        switch url.host {
        case "legacy.invalid":
            status = 404
            body = #"{"error":"Not found"}"#
        case "missing.invalid":
            status = 404
            body = #"{"error":"Unknown artifact or revision"}"#
        case "empty.invalid":
            body = "[]"
        case "invalid-list.invalid":
            body = #"[{"id":"wrong","sessionId":"other","title":"Other chat","kind":"html","revision":1,"createdAt":1,"updatedAt":2}]"#
        default:
            // Incorrect routes must fail rather than silently accepting a bad client URL.
            if url.path == "/api/sessions/session/artifacts/artifact" {
                let revision = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value ?? "2"
                body = """
                {"id":"artifact","sessionId":"session","title":"Preview","kind":"html",
                 "revision":\(revision),"createdAt":1,"updatedAt":2,"source":"<h1>Saved</h1>",
                 "html":"<h1>Saved</h1>","libraries":[]}
                """
            } else if url.path == "/api/sessions/session/artifacts" {
                body = """
                [{"id":"artifact","sessionId":"session","title":"Preview","kind":"html",
                  "revision":2,"createdAt":1,"updatedAt":4},
                 {"id":"react","sessionId":"session","title":"Dashboard","kind":"react",
                  "revision":1,"createdAt":2,"updatedAt":3},
                 {"id":"image","sessionId":"session","title":"Image","kind":"image",
                  "revision":1,"createdAt":1,"updatedAt":2}]
                """
            } else if url.path == "/api/sessions/other/artifacts" {
                body = #"[{"id":"other","sessionId":"other","title":"Other chat","kind":"html","revision":1,"createdAt":1,"updatedAt":2}]"#
            } else {
                status = 404
                body = #"{"error":"Not found"}"#
            }
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor private func artifactClient(_ host: String) -> PilotClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ArtifactHTTPStub.self]
    return PilotClient(baseURL: URL(string: "http://\(host)"), artifactSession: URLSession(configuration: configuration))
}

private let previewReference = ArtifactReference(id: "artifact", sessionId: "session", title: "Preview", revision: 1)

@Test @MainActor func artifactCardsStartWithPreviewInsteadOfSource() {
    let state = ArtifactViewState()
    #expect(state.preview)
    #expect(!state.visible) // The renderer still waits for the row to appear.
    state.preview.toggle()
    #expect(!state.preview)
}

@Test @MainActor func artifactClientReadsPinnedAndLatestRevisions() async throws {
    let client = artifactClient("current.invalid")
    let pinned = try await client.artifact(previewReference)
    #expect(pinned.revision == 1)
    #expect(pinned.html == "<h1>Saved</h1>")
    let latest = try await client.artifact(previewReference, latest: true)
    #expect(latest.revision == 2)
}

@Test @MainActor func legacyArtifactRoutesExplainHowToRecover() async {
    let client = artifactClient("legacy.invalid")
    for read in 0..<3 {
        do {
            switch read {
            case 0: _ = try await client.artifact(previewReference)
            case 1: _ = try await client.sessionArtifacts("session")
            default: _ = try await client.projectArtifacts("project")
            }
            Issue.record("Legacy routes must report an error")
        } catch {
            #expect(error.localizedDescription.contains("does not support artifacts"))
            #expect(error.localizedDescription.contains("Once agents are idle"))
            #expect(error.localizedDescription.contains("restart pilotd"))
        }
    }
}

@Test @MainActor func missingArtifactIsNotMistakenForAnOldDaemon() async {
    do {
        _ = try await artifactClient("missing.invalid").artifact(previewReference)
        Issue.record("Missing artifacts must report an error")
    } catch {
        #expect(error.localizedDescription == "Unknown artifact or revision")
    }
}

@Test @MainActor func artifactsPaneLoadsEveryKindWithoutMixingChats() async throws {
    let client = artifactClient("current.invalid")
    let state = SessionArtifactsState()
    await state.load(sessionId: "session", client: client)
    #expect(!state.loading)
    #expect(state.error == nil)
    let artifacts = try #require(client.artifacts["session"])
    #expect(artifacts.map(\.id) == ["artifact", "react", "image"])
    #expect(artifacts.map(\.kind) == [.html, .react, .image])
    #expect(artifacts.allSatisfy { $0.sessionId == "session" })

    await state.load(sessionId: "other", client: client)
    #expect(client.artifacts["other"]?.map(\.id) == ["other"])
    #expect(client.artifacts["session"] == artifacts)
    state.selected = artifacts[0].reference
    #expect(state.selected?.revision == 2)
    #expect(state.selected?.sessionId == "session")
}

@Test @MainActor func artifactsPaneSupportsEmptyListsAndRefreshes() async {
    let client = artifactClient("current.invalid")
    let state = SessionArtifactsState()
    await state.load(sessionId: "session", client: client)
    #expect(client.artifacts["session"]?.first?.revision == 2)
    await state.load(sessionId: "session", client: client)
    #expect(client.artifacts["session"]?.first?.revision == 2)
    #expect(client.artifacts["session"]?.count == 3)
    #expect(!state.loading)

    let emptyClient = artifactClient("empty.invalid")
    await state.load(sessionId: "session", client: emptyClient)
    #expect(emptyClient.artifacts["session"] == [])
    #expect(state.error == nil)
    #expect(!state.loading)
}

@Test @MainActor func artifactsPaneShowsErrorsAndRecoversOnRetry() async {
    let state = SessionArtifactsState()
    await state.load(sessionId: "session", client: artifactClient("legacy.invalid"))
    #expect(state.error?.contains("restart pilotd") == true)
    #expect(!state.loading)
    await state.load(sessionId: "session", client: artifactClient("current.invalid"))
    #expect(state.error == nil)
    #expect(!state.loading)

    let invalidClient = artifactClient("invalid-list.invalid")
    await state.load(sessionId: "session", client: invalidClient)
    #expect(state.error == "Invalid artifact list")
    #expect(invalidClient.artifacts["session"] == nil)
}
