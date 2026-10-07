import Foundation
import Testing
@testable import PilotCore

private final class UpdateFeedHTTPStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        #expect(request.url?.host == "api.github.com")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/octet-stream")
        #expect(request.value(forHTTPHeaderField: "X-GitHub-Api-Version") == "2022-11-28")
        #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)
        #expect(request.timeoutInterval == 30)
        let id = request.url!.lastPathComponent
        let location: String?
        switch id {
        case "1": location = "https://release-assets.githubusercontent.com/asset/appcast.xml?sig=temporary"
        case "4": location = "https://evil.example/appcast.xml?sig=temporary"
        case "5": location = "http://release-assets.githubusercontent.com/asset/appcast.xml"
        case "6": location = "https://user@release-assets.githubusercontent.com/asset/appcast.xml"
        case "7": location = "https://release-assets.githubusercontent.com:443/asset/appcast.xml"
        case "8": location = "https://release-assets.githubusercontent.com/asset/appcast.xml#fragment"
        default: location = nil
        }
        let status = id == "2" ? 200 : (id == "3" ? 401 : 302)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                       headerFields: location.map { ["Location": $0] })!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"name":"appcast.xml"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func feedSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [UpdateFeedHTTPStub.self]
    return URLSession(configuration: configuration)
}

@Test func updateFeedResolvesSignedDownloadWithGitHubAcceptHeader() async throws {
    let repository = UpdateRepository("owner/repo")!
    let session = feedSession()
    defer { session.invalidateAndCancel() }
    let url = try await UpdateFeed.resolve(repository: repository, assetURL: repository.assetURL(id: 1),
                                           token: "test-token", session: session)
    #expect(url.absoluteString == "https://release-assets.githubusercontent.com/asset/appcast.xml?sig=temporary")
}

@Test func updateFeedRejectsMetadataMissingAndUnsafeRedirects() async {
    let repository = UpdateRepository("owner/repo")!
    let session = feedSession()
    defer { session.invalidateAndCancel() }
    for id in [2, 4, 5, 6, 7, 8, 9] {
        do {
            _ = try await UpdateFeed.resolve(repository: repository, assetURL: repository.assetURL(id: id),
                                             token: "test-token", session: session)
            Issue.record("Accepted an invalid feed response for asset \(id)")
        } catch {
            #expect(!error.localizedDescription.contains("temporary"))
            #expect(!error.localizedDescription.contains("test-token"))
        }
    }
}

@Test func updateFeedPreservesAuthenticationFailuresForCredentialFallback() async {
    let repository = UpdateRepository("owner/repo")!
    let session = feedSession()
    defer { session.invalidateAndCancel() }
    do {
        _ = try await UpdateFeed.resolve(repository: repository, assetURL: repository.assetURL(id: 3),
                                         token: "test-token", session: session)
        Issue.record("Accepted a denied feed request")
    } catch {
        #expect((error as NSError).userInfo["GitHubHTTPStatus"] as? Int == 401)
    }
}

@Test func updateFeedRejectsForeignAssetBeforeSendingCredentials() async {
    let repository = UpdateRepository("owner/repo")!
    let session = feedSession()
    defer { session.invalidateAndCancel() }
    do {
        _ = try await UpdateFeed.resolve(repository: repository, assetURL: UpdateRepository("other/repo")!.assetURL(id: 1),
                                         token: "test-token", session: session)
        Issue.record("Accepted a foreign API asset")
    } catch {
        #expect(error.localizedDescription.contains("configured repository"))
    }
}
