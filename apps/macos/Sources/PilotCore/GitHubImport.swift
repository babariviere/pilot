import Foundation

public struct GitHubRepositoryChoice: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let url: String
    public let `private`: Bool
    public var id: String { url }
}
public struct GitHubRepositoryChoices: Codable, Sendable {
    public let repositories: [GitHubRepositoryChoice]
    public let truncated: Bool
}
public struct GitHubImportRequest: Codable, Equatable, Sendable {
    public let id: String
    public let url: String
    public let destination: String
    public init(id: String = UUID().uuidString.lowercased(), url: String, destination: String) {
        self.id = id; self.url = url; self.destination = destination
    }
}
public struct GitHubImportOperation: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let url: String
    public let destination: String
    public let phase: String
    public let projectId: String?
    public let problem: String?
    public var working: Bool { ["queued", "cloning", "registering"].contains(phase) }
}
public enum GitHubImportValidation {
    public static func repository(_ input: String) -> String? {
        let pattern = #"^(?:https://github\.com/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99}?)(?:\.git)?/?$"#
        guard input.utf8.count <= 512, let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: input, range: NSRange(input.startIndex..., in: input)),
              let owner = Range(match.range(at: 1), in: input), let repo = Range(match.range(at: 2), in: input) else { return nil }
        return "https://github.com/\(input[owner])/\(input[repo])"
    }
}

public struct GitHubImportPreview: Codable, Equatable, Sendable {
    public let destination: String
    public let resolvedDestination: String
}
public enum ProjectDestinationPolicy {
    public static let defaultPattern = "~/src/{host}/{owner}/{repo}"
    public static func destination(repository: String) -> String? {
        guard let url = GitHubImportValidation.repository(repository), let parsed = URL(string: url),
              let host = parsed.host else { return nil }
        let pieces = parsed.path.split(separator: "/")
        guard pieces.count == 2 else { return nil }
        return defaultPattern.replacingOccurrences(of: "{host}", with: host)
            .replacingOccurrences(of: "{owner}", with: String(pieces[0]))
            .replacingOccurrences(of: "{repo}", with: String(pieces[1]))
    }
}
