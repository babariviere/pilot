import Foundation

public struct RepositorySelection: Codable, Equatable, Sendable {
    public let rootId: String
    public let path: String
    public init(rootId: String = "home", path: String = "") { self.rootId = rootId; self.path = path }
}
public struct RepositoryDirectory: Codable, Identifiable, Equatable, Sendable {
    public let name: String
    public let path: String
    public var id: String { path }
}
public struct RepositoryDirectoryPage: Codable, Equatable, Sendable {
    public let rootId: String
    public let path: String
    public let entries: [RepositoryDirectory]
    public let nextOffset: Int?
    public let truncated: Bool
}
public struct SessionFileContent: Codable, Equatable, Sendable {
    public let path: String
    public let text: String
    public let truncated: Bool
    public let binary: Bool
}

/// Host-local repository placement. Confirming this does not share context, credentials or trust.
public struct RepositoryMapping: Codable, Equatable, Sendable {
    public let logicalProjectId: String
    public let project: HostResourceRef
    public let remotePath: String
    public let generation: UInt64
}

public struct RepositoryBindings: Codable, Equatable, Sendable {
    public private(set) var mappings: [RepositoryMapping] = []
    public init() {}
    public func mapping(logicalProjectId: String, host: HostRef) -> RepositoryMapping? {
        mappings.first { $0.logicalProjectId == logicalProjectId && $0.project.host == host }
    }
    /// Only an explicit user-confirmed selection calls this. No path/name/remote-URL inference.
    public mutating func confirm(logicalProjectId: String, project: HostResourceRef, remotePath: String,
                                 expectedGeneration: UInt64?) throws -> RepositoryMapping {
        guard project.kind == .project, !remotePath.isEmpty else { throw HostRoutingError.invalidReference }
        let current = mapping(logicalProjectId: logicalProjectId, host: project.host)
        guard current?.generation == expectedGeneration else { throw HostRoutingError.staleGeneration }
        let next = RepositoryMapping(logicalProjectId: logicalProjectId, project: project, remotePath: remotePath,
                                     generation: (current?.generation ?? 0) + 1)
        mappings.removeAll { $0.logicalProjectId == logicalProjectId && $0.project.host == project.host }
        mappings.append(next)
        return next
    }
}

