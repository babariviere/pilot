import Foundation

/// An unpinned reference to a locally published artifact, independent of its originating chat.
public struct ArtifactLink: Identifiable, Equatable, Sendable {
    public let id: String

    public init?(url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "artifact", parts.user == nil, parts.password == nil,
              parts.port == nil, parts.path.isEmpty, parts.query == nil, parts.fragment == nil,
              let host = parts.host, host.count == 36, let uuid = UUID(uuidString: host),
              host.lowercased() == uuid.uuidString.lowercased() else { return nil }
        id = uuid.uuidString.lowercased()
    }
}
