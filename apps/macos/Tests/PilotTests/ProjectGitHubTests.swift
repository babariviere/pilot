import Foundation
import PilotCore
import Testing
@testable import Pilot

private final class ProjectGitHubHTTPStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "project-github.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let success = request.url?.path == "/api/projects/remote-project/github" && request.httpMethod == "GET"
        let response = HTTPURLResponse(url: request.url!, statusCode: success ? 200 : 503, httpVersion: nil,
                                       headerFields: ["content-type": "application/json"])!
        let body = success ? #"{"url":"https://github.com/octo/repo"}"# : #"{"error":"Check remotes and GitHub CLI sign-in"}"#
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Test @MainActor func projectGitHubClientResolvesViaDaemonAndSurfacesFailures() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ProjectGitHubHTTPStub.self]
    let client = PilotClient(baseURL: URL(string: "http://project-github.invalid"), commandConfiguration: configuration)
    let url = try await client.projectGitHubURL("remote-project")
    #expect(url.absoluteString == "https://github.com/octo/repo")
    do {
        _ = try await client.projectGitHubURL("missing")
        Issue.record("Expected a failed repository lookup")
    } catch {
        #expect(error.localizedDescription == "Check remotes and GitHub CLI sign-in")
    }
}

@Test @MainActor func paletteOffersGitHubForEveryProjectAndSuggestsTheVisibleOne() {
    let app = AppModel()
    let projects = [Project(id: "one", name: "Pilot", path: "/one", createdAt: 1),
                    Project(id: "two", name: "Other", path: "/two", createdAt: 2)]
    app.client.loadFixture(projects: projects, sessions: [])
    app.openProject("two")
    let catalog = CommandPaletteCatalog(model: app, openSettings: {})
    let entries = catalog.entries().filter { $0.item.id.hasPrefix("github:") }
    #expect(Set(entries.map(\.item.id)) == ["github:one", "github:two"])
    #expect(entries.allSatisfy { $0.item.title == "Open on GitHub" })
    #expect(entries.first { $0.item.id == "github:two" }?.item.suggested == true)
    #expect(entries.first { $0.item.id == "github:one" }?.item.suggested == false)
    #expect(entries.first { $0.item.id == "github:two" }?.suffix == "Other")
    #expect(entries.allSatisfy { $0.item.keywords.contains("repository") })
}
