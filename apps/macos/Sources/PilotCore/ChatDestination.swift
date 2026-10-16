import Foundation

/// An in-app chat destination. Opening a link never starts or changes the chat.
public struct ChatDestination: Equatable, Sendable {
    public let sessionId: String

    public init?(url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "pilot", parts.host?.lowercased() == "chat",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.first == "/", parts.path.count == 37,
              let uuid = UUID(uuidString: String(parts.path.dropFirst())) else { return nil }
        sessionId = uuid.uuidString.lowercased()
    }
}
