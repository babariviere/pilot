import Foundation
import Testing
@testable import PilotCore

@Test func updateRepositoryRestrictsCredentialDestinations() {
    let repository = UpdateRepository("owner/private-app")!
    #expect(repository.latestReleaseURL.absoluteString == "https://api.github.com/repos/owner/private-app/releases/latest")
    #expect(repository.permitsAssetURL(repository.assetURL(id: 123)))
    for address in [
        "http://api.github.com/repos/owner/private-app/releases/assets/123",
        "https://evil.example/repos/owner/private-app/releases/assets/123",
        "https://api.github.com/repos/other/private-app/releases/assets/123",
        "https://api.github.com/repos/owner/private-app/releases/assets/0",
        "https://api.github.com/repos/owner/private-app/releases/assets/123?redirect=evil",
        "https://api.github.com/repos/owner/private-app/releases/assets/123/extra",
        "https://user@api.github.com/repos/owner/private-app/releases/assets/123",
    ] { #expect(!repository.permitsAssetURL(URL(string: address)!)) }
    for name in ["owner", "owner/repo/extra", "owner/", "../repo", "owner/repo?x=y"] {
        #expect(UpdateRepository(name) == nil)
    }
}

@Test func updateReleaseRequiresCompletePublishedAssets() throws {
    let json = #"{"draft":false,"prerelease":false,"assets":[{"id":1,"name":"appcast.xml","state":"uploaded"},{"id":2,"name":"Pilot-arm64.zip","state":"uploaded"}]}"#
    let release = try JSONDecoder().decode(UpdateRelease.self, from: Data(json.utf8))
    #expect(release.updateAssets()?.feed.id == 1)
    #expect(release.updateAssets()?.archive.id == 2)
    for invalid in [
        json.replacingOccurrences(of: "\"draft\":false", with: "\"draft\":true"),
        json.replacingOccurrences(of: "\"prerelease\":false", with: "\"prerelease\":true"),
        json.replacingOccurrences(of: "Pilot-arm64.zip", with: "Pilot-x64.zip"),
        json.replacingOccurrences(of: "uploaded", with: "new"),
    ] {
        #expect(try JSONDecoder().decode(UpdateRelease.self, from: Data(invalid.utf8)).updateAssets() == nil)
    }
}
