import Foundation

/// Only GitHub's API asset endpoints in this repository may receive update credentials.
public struct UpdateRepository: Equatable, Sendable {
    public let name: String

    public init?(_ name: String) {
        let parts = name.split(separator: "/", omittingEmptySubsequences: false)
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        guard parts.count == 2, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.unicodeScalars.allSatisfy(allowed.contains) }) else {
            return nil
        }
        self.name = name
    }

    public var latestReleaseURL: URL { URL(string: "https://api.github.com/repos/\(name)/releases/latest")! }

    public func assetURL(id: Int) -> URL {
        URL(string: "https://api.github.com/repos/\(name)/releases/assets/\(id)")!
    }

    public func permitsAssetURL(_ url: URL) -> Bool {
        guard url.scheme == "https", url.host == "api.github.com", url.port == nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
        else { return false }
        let prefix = "/repos/\(name)/releases/assets/"
        guard url.path.hasPrefix(prefix) else { return false }
        let id = url.path.dropFirst(prefix.count)
        return !id.isEmpty && id.allSatisfy({ $0.isASCII && $0.isNumber }) && Int(id).map({ $0 > 0 }) == true
    }
}

public struct UpdateRelease: Decodable, Sendable {
    public struct Asset: Decodable, Sendable {
        public let id: Int
        public let name: String
        public let state: String
    }

    public let draft: Bool
    public let prerelease: Bool
    public let assets: [Asset]

    public func updateAssets() -> (feed: Asset, archive: Asset)? {
        guard !draft, !prerelease,
              let feed = assets.first(where: { $0.name == "appcast.xml" && $0.state == "uploaded" && $0.id > 0 }),
              let archive = assets.first(where: { $0.name == "Pilot-arm64.zip" && $0.state == "uploaded" && $0.id > 0 })
        else { return nil }
        return (feed, archive)
    }
}
