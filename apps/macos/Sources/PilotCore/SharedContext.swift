import Foundation

// Mirrors packages/protocol/src/shared-context.ts. These are daemon journal identities,
// not configured endpoint aliases. Only verified installation/lineage pins resolve them.
public struct OperationHost: Codable, Hashable, Sendable {
    public let hostId: String
    public let daemonId: String
    public let lineageId: String
    public init(hostId: String = "daemon", daemonId: String, lineageId: String) {
        self.hostId = hostId; self.daemonId = daemonId; self.lineageId = lineageId
    }
    public init(_ host: HostRef) { self.init(daemonId: host.daemonId, lineageId: host.lineageId) }
    public var envelopeIdentity: HostRef { HostRef(hostId: hostId, daemonId: daemonId, lineageId: lineageId) }
    public func matches(_ pin: HostRef) -> Bool {
        hostId == "daemon" && !daemonId.isEmpty && !lineageId.isEmpty
            && daemonId == pin.daemonId && lineageId == pin.lineageId
    }
}

public struct SharedProjectRef: Codable, Equatable, Sendable {
    public let host: OperationHost
    public let projectId: String
    public init(host: OperationHost, projectId: String) { self.host = host; self.projectId = projectId }
}
public struct SharedMissionRef: Codable, Equatable, Sendable {
    public let home: OperationHost
    public let missionId: String
}
public struct SharedTaskRef: Codable, Equatable, Sendable {
    public let mission: SharedMissionRef
    public let taskId: String
}
public struct SharedSessionRef: Codable, Equatable, Sendable {
    public let host: OperationHost
    public let sessionId: String
}
public struct SharedContextBinding: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let bindingId: String
    public let generation: UInt64
    public let logicalProjectId: String
    public let memoryHome: SharedProjectRef
    public let missionHome: OperationHost
    public let executionProject: SharedProjectRef
    public let missionIds: [String]
    public let shareMemory: Bool
    public let state: State
    public enum State: String, Codable, Sendable { case active, revoked }
    public var peers: Set<OperationHost> { [memoryHome.host, missionHome, executionProject.host] }
    public init(schemaVersion: Int = 1, bindingId: String, generation: UInt64, logicalProjectId: String,
                memoryHome: SharedProjectRef, missionHome: OperationHost, executionProject: SharedProjectRef,
                missionIds: [String], shareMemory: Bool, state: State = .active) {
        self.schemaVersion = schemaVersion; self.bindingId = bindingId; self.generation = generation
        self.logicalProjectId = logicalProjectId; self.memoryHome = memoryHome; self.missionHome = missionHome
        self.executionProject = executionProject; self.missionIds = missionIds; self.shareMemory = shareMemory
        self.state = state
    }
}
public struct SharedContextVector: Codable, Equatable, Sendable {
    public let memory: Int
    public let mission: Int
}
public struct SharedContextFreshness: Codable, Equatable, Sendable {
    public let applied: SharedContextVector
    public let observedHead: SharedContextVector?
    public let complete: Bool
    public let pendingCount: Int
    public let conflictCount: Int
    public let lastSyncedAt: Double?
}
public struct SharedMemoryMutation: Codable, Equatable, Sendable {
    public let operationId: String
    public let payloadHash: String
    public let noteId: String
    public let origin: SharedSessionRef
    public let text: String
    public let replaces: [Replacement]
    public struct Replacement: Codable, Equatable, Sendable {
        public let id: String
        public let expectedReplacementId: String?
        private enum CodingKeys: String, CodingKey { case id, expectedReplacementId }
        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            expectedReplacementId = try container.decode(String?.self, forKey: .expectedReplacementId)
        }
        public func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(id, forKey: .id)
            // null asserts a live note. Omitting it would lose the CAS precondition.
            try container.encode(expectedReplacementId, forKey: .expectedReplacementId)
        }
    }
}
public struct SharedMemoryCommitOutcome: Codable, Equatable, Sendable {
    public let operationId: String
    public let state: State
    public let sequence: Int
    public let entry: MemoryEntry?
    public let reason: String?
    public enum State: String, Codable, Sendable {
        case committed, alreadyPresent = "already-present", conflict, rejected
    }
}
public struct SharedMemoryCheckpointManifest: Codable, Equatable, Sendable {
    public let checkpointId: String
    public let sequence: Int
    public let count: Int
    public let digest: String
}
public struct SharedMemoryCheckpointPage: Codable, Equatable, Sendable {
    public let checkpointId: String
    public let cursor: Int
    public let entries: [MemoryEntry]
    public let next: Int?
}
public struct SharedMemoryChange: Codable, Equatable, Sendable {
    public let sequence: Int
    public let entry: MemoryEntry
}
public struct SharedMemoryChangePage: Codable, Equatable, Sendable {
    public let after: Int
    public let head: Int
    public let changes: [SharedMemoryChange]
    public let next: Int?
    public let checkpointRequired: Bool?
}
public struct SharedMemoryReplicaState: Codable, Equatable, Sendable {
    public let sequence: Int
    public let complete: Bool
    public let pendingCount: Int
    public let conflictCount: Int
    /// Distinguishes durable provisional overlays even when their counts are unchanged.
    public let overlayRevision: Int?
}
public struct SharedMemoryProposal: Codable, Equatable, Sendable {
    public let mutation: SharedMemoryMutation
    public let state: State
    public let reason: String?
    public enum State: String, Codable, Sendable { case pending, conflict, rejected }
}
public struct SharedMemoryRead: Codable, Equatable, Sendable {
    public let state: SharedMemoryReplicaState
    public let value: Value
    public let proposals: [SharedMemoryProposal]
    public enum Value: Codable, Equatable, Sendable {
        case view(MemoryView), recall(MemoryRecall), nodes([MemoryNode])
        public init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let view = try? container.decode(MemoryView.self) { self = .view(view) }
            else if let recall = try? container.decode(MemoryRecall.self) { self = .recall(recall) }
            else { self = .nodes(try container.decode([MemoryNode].self)) }
        }
        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case let .view(value): try container.encode(value)
            case let .recall(value): try container.encode(value)
            case let .nodes(value): try container.encode(value)
            }
        }
    }
}
public struct SharedEntity: Codable, Equatable, Sendable {
    public let id: String
    public let kind: Kind
    public let revision: Int
    /// Missing in older replicas. Do not substitute the execution-progress revision.
    public let definitionRevision: Int?
    public let deleted: Bool
    public let value: JSONValue?
    public enum Kind: String, Codable, Sendable {
        case mission, brief, task, decision, comment, resource, artifact, phase
    }
}
public struct SharedMissionChange: Codable, Equatable, Sendable {
    public let sequence: Int
    public let missionId: String
    public let entity: SharedEntity
}
public struct SharedMissionSnapshot: Codable, Equatable, Sendable {
    public let missionId: String
    public let sequence: Int
    public let detail: MissionDetail
    public let entities: [SharedEntity]
}
public enum SharedReadSource: String, Codable, Sendable { case canonical, replica }
public struct SharedEntityVersion: Codable, Equatable, Sendable {
    public let id: String
    public let kind: SharedEntity.Kind
    public let revision: Int
    public let definitionRevision: Int?
    public let deleted: Bool
}
public struct SharedMissionVersions: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let missionId: String
    public let authority: OperationHost
    public let source: SharedReadSource
    public let sequence: Int
    public let complete: Bool
    public let entities: [SharedEntityVersion]
    /// Pass this offset and the original sequence when requesting the next page.
    public let next: Int?
}
public struct SharedMissionRead: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let authority: OperationHost
    public let source: SharedReadSource
    public let snapshot: SharedMissionSnapshot
    /// Kept separate from committed detail, including after a conflicting edit.
    public let proposals: [SharedMissionProposal]
}
public struct SharedMemoryTreeRead: Codable, Equatable, Sendable {
    public let state: SharedMemoryReplicaState
    public let value: MemoryTree
    public let proposals: [SharedMemoryProposal]
}
public struct SharedMissionProposal: Codable, Equatable, Sendable {
    public let proposalId: String
    public let missionId: String
    public let entityId: String
    public let expectedRevision: Int
    public let action: String
    public let args: [String: JSONValue]
    public let origin: SharedSessionRef
    public let state: State
    public let reason: String?
    public let canonicalId: String?
    public enum State: String, Codable, Sendable { case pending, committed, conflict, rejected }
}
public struct SharedContextConflict: Codable, Equatable, Sendable {
    public let operationId: String
    public let bindingId: String
    public let reason: String
    public let base: JSONValue?
    public let current: JSONValue?
    public let incoming: JSONValue
}
public struct DelegationGrant: Codable, Sendable {
    public let delegationId: String
    public let task: SharedTaskRef
    public let executionEpoch: Int
    public let bindingId: String
    public let bindingGeneration: UInt64
    public let target: SharedProjectRef
    public let session: SharedSessionRef
    public let definitionRevision: Int
    public let context: SharedContextVector
    public let manifestId: String
    public let references: [SharedContextReference]
    /// Links explicitly acknowledged as unavailable while offline.
    public let onlineOnlyUrls: [String]?
    public let request: SpawnRequest
    public let state: State
    public enum State: String, Codable, Sendable { case reserved, accepted, cancelRequested = "cancel_requested", sealed }
}
public struct SharedContextReference: Codable, Equatable, Sendable {
    public let host: OperationHost
    public let sessionId: String
    public let artifactId: String
    public let revision: Int
    public let requirement: Requirement
    public let digest: String?
    public enum Requirement: String, Codable, Sendable { case required, optionalOnline = "optional-online" }
}
public struct DelegatedMembership: Codable, Sendable {
    public let grant: DelegationGrant
    public let freshness: SharedContextFreshness
}
public struct DelegationEvent: Codable, Equatable, Sendable {
    public let eventId: String
    public let delegationId: String
    public let executionEpoch: Int
    public let sequence: Int
    public let kind: Kind
    public let payload: [String: JSONValue]
    public enum Kind: String, Codable, Sendable { case progress, result, question, artifact, pullRequest = "pull-request", sealed }
}
public struct SharedExchangeBatch: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let operations: [DurableOperation]
    public let more: Bool
}
public struct SharedExchangeAcknowledgment: Codable, Equatable, Sendable {
    public let operation: DurableOperation
    public let receipt: OperationReceipt
    public init(operation: DurableOperation, receipt: OperationReceipt) {
        self.operation = operation; self.receipt = receipt
    }
}
public struct SharedContextSummary: Codable, Sendable {
    public let binding: SharedContextBinding
    public let freshness: SharedContextFreshness
    public let grants: [DelegationGrant]
}
