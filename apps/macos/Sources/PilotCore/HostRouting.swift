import Foundation

/// Configuration identity, installation identity and storage history are not socket generations.
/// Restoring/cloning a data home must rotate lineageId before it can be enrolled again.
public struct HostRef: Codable, Hashable, Sendable {
    public let hostId: String
    public let daemonId: String
    public let lineageId: String
    public init(hostId: String, daemonId: String, lineageId: String) {
        self.hostId = hostId; self.daemonId = daemonId; self.lineageId = lineageId
    }

    public func validate(_ hello: DaemonHello) throws {
        guard hello.isProtocolCompatible, hello.capabilities.independentExecution else { throw HostRoutingError.incompatible }
        guard hello.daemonId == daemonId, hello.lineageId == lineageId else {
            throw HostRoutingError.identityChanged
        }
    }
}

public enum HostResourceKind: String, Codable, Sendable { case session, project, mission, artifact, schedule }

public struct HostResourceRef: Codable, Hashable, Identifiable, Sendable {
    public let host: HostRef
    public let kind: HostResourceKind
    public let localId: String
    public var id: Self { self }
    public init(host: HostRef, kind: HostResourceKind, localId: String) {
        self.host = host; self.kind = kind; self.localId = localId
    }
    /// Versioned JSON, not delimiter concatenation. IDs may contain delimiters or Unicode.
    public var storageKey: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return "hostref1:" + (try! encoder.encode(self)).base64EncodedString()
    }
    public static func decodeKey(_ key: String) throws -> Self {
        guard key.hasPrefix("hostref1:"), let data = Data(base64Encoded: String(key.dropFirst(9))) else {
            throw HostRoutingError.invalidReference
        }
        return try JSONDecoder().decode(Self.self, from: data)
    }
}

public struct Hosted<Value: Sendable>: Identifiable, Sendable {
    public let ref: HostResourceRef
    public let value: Value
    public var id: HostResourceRef { ref }
    public init(ref: HostResourceRef, value: Value) { self.ref = ref; self.value = value }
}

public struct ProjectBinding: Codable, Equatable, Sendable {
    public let logicalProjectId: String
    public let bindingId: String
    public let generation: UInt64
    public let executionProject: HostResourceRef
    public let memoryHome: HostResourceRef
    public let missionHome: HostRef
    public init(logicalProjectId: String, bindingId: String, generation: UInt64,
                executionProject: HostResourceRef, memoryHome: HostResourceRef, missionHome: HostRef) throws {
        guard executionProject.kind == .project, memoryHome.kind == .project, generation > 0 else {
            throw HostRoutingError.invalidReference
        }
        self.logicalProjectId = logicalProjectId; self.bindingId = bindingId; self.generation = generation
        self.executionProject = executionProject; self.memoryHome = memoryHome; self.missionHome = missionHome
    }
}

/// An ephemeral response fence. Never use this value as a durable operation/binding identity.
public struct HostConnectionToken: Equatable, Sendable {
    public let host: HostRef
    public let generation: UUID
    public init(host: HostRef, generation: UUID = UUID()) { self.host = host; self.generation = generation }
}

public enum HostRoutingError: LocalizedError, Equatable {
    case disconnected, identityChanged, incompatible, staleGeneration, invalidReference, migrationConflict
    public var errorDescription: String? {
        switch self {
        case .disconnected: "Disconnected. Reconnect to use this host."
        case .identityChanged: "The host identity changed. Repair the connection before continuing."
        case .incompatible: "This host is not compatible with this client."
        case .staleGeneration: "The connection changed. Refresh before continuing."
        case .invalidReference: "Invalid host-qualified resource."
        case .migrationConflict: "Saved drafts conflict. The original data was kept."
        }
    }
}

/// Separate last-known execution data from availability. Reconnect replaces only its own partition.
public struct HostPartition<Value: Sendable>: Sendable {
    public let host: HostRef
    public private(set) var token: HostConnectionToken?
    public private(set) var values: [String: Value]
    public init(host: HostRef, values: [String: Value] = [:]) { self.host = host; self.values = values }
    public mutating func connect() -> HostConnectionToken {
        let next = HostConnectionToken(host: host); token = next; return next
    }
    public mutating func disconnect() { token = nil }
    public mutating func replace(_ values: [String: Value], token: HostConnectionToken) throws {
        guard self.token == token, token.host == host else { throw HostRoutingError.staleGeneration }
        self.values = values
    }
}

/// Bare legacy keys can be migrated only by the explicitly identified local installation.
/// Qualified remote keys survive unchanged, and collisions fail closed instead of losing drafts.
public enum HostKeyMigration {
    public static func local<Value>(_ values: [String: Value], host: HostRef,
                                    kind: HostResourceKind) throws -> [String: Value] {
        var result: [String: Value] = [:]
        for (key, value) in values {
            let target: String
            if key.hasPrefix("hostref1:") {
                _ = try HostResourceRef.decodeKey(key); target = key
            } else { target = HostResourceRef(host: host, kind: kind, localId: key).storageKey }
            guard result.updateValue(value, forKey: target) == nil else { throw HostRoutingError.migrationConflict }
        }
        return result
    }
}

/// Resources always inherit an owner's host; absolute paths are never resource identities.
public struct HostedArtifactReference: Codable, Hashable, Sendable {
    public let host: HostRef
    public let artifact: ArtifactReference
    public init(host: HostRef, artifact: ArtifactReference) { self.host = host; self.artifact = artifact }
}
