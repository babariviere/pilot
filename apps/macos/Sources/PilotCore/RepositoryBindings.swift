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

public struct SessionPathCandidates: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let path: String
        public let directory: Bool
    }
    public let sessionId: String
    public let cwd: String
    public let prefix: String
    public let daemonId: String
    public let lineageId: String
    public let entries: [Entry]
    public let truncated: Bool
}

/// Host-local repository placement. Confirming this does not share context, credentials or trust.
public struct RepositoryMapping: Codable, Equatable, Sendable {
    public let logicalProjectId: String
    public let project: HostResourceRef
    public let remotePath: String
    public let generation: UInt64
    public let sourcePath: String?
    public let sourceOrigin: String?
    public let destinationOrigin: String?
}

public struct RepositoryBindings: Codable, Equatable, Sendable {
    public private(set) var mappings: [RepositoryMapping] = []
    public init() {}
    public func mapping(logicalProjectId: String, host: HostRef) -> RepositoryMapping? {
        mappings.first { $0.logicalProjectId == logicalProjectId && $0.project.host == host }
    }
    /// Only an explicit user-confirmed selection calls this. No path/name/remote-URL inference.
    public mutating func confirm(logicalProjectId: String, project: HostResourceRef, remotePath: String,
                                 expectedGeneration: UInt64?, sourcePath: String? = nil,
                                 sourceOrigin: String? = nil, destinationOrigin: String? = nil) throws -> RepositoryMapping {
        guard project.kind == .project, !remotePath.isEmpty else { throw HostRoutingError.invalidReference }
        let current = mapping(logicalProjectId: logicalProjectId, host: project.host)
        guard current?.generation == expectedGeneration else { throw HostRoutingError.staleGeneration }
        let next = RepositoryMapping(logicalProjectId: logicalProjectId, project: project, remotePath: remotePath,
                                     generation: (current?.generation ?? 0) + 1, sourcePath: sourcePath,
                                     sourceOrigin: sourceOrigin, destinationOrigin: destinationOrigin)
        mappings.removeAll { $0.logicalProjectId == logicalProjectId && $0.project.host == project.host }
        mappings.append(next)
        return next
    }

    public mutating func remove(logicalProjectId: String, host: HostRef) {
        mappings.removeAll { $0.logicalProjectId == logicalProjectId && $0.project.host == host }
    }
}
