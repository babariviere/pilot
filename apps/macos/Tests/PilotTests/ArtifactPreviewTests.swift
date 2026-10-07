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
        default:
            // Incorrect routes must fail rather than silently accepting a bad client URL.
            if url.path == "/api/sessions/session/artifacts/artifact" {
                let revision = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value ?? "2"
                body = """
                {"id":"artifact","sessionId":"session","title":"Preview","kind":"html",
                 "revision":\(revision),"createdAt":1,"updatedAt":2,"source":"<h1>Saved</h1>",
                 "html":"<h1>Saved</h1>","libraries":[]}
                """
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
    #expect(!state.source)
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
