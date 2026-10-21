import Foundation

public struct MissionCatalogResponse: Codable, Equatable, Sendable {
    public let logicalMissions: [LogicalMission]?
    public let missions: [CatalogMission]
    public let sharedTasks: [CatalogSharedTask]?
    public let replicaMissions: [CatalogReplicaMission]?
    public struct Totals: Codable, Equatable, Sendable { public let logicalMissions: Int? }
    public let totals: Totals
    public let truncated: Bool
}

public struct LogicalMission: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let mission: SharedMissionRef
    public let title: String?
    public let status: MissionStatus?
    public let tasksDone: Int?
    public let tasksTotal: Int?
    public let coordinator: SharedSessionRef?
    public let provenance: [MissionProvenance]
}
public struct MissionProvenance: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case canonical, replica }
    public let kind: Kind
    public let sourceHost: OperationHost
    public let projectId: String
    public let bindingId: String?
    public let sequence: Int?
    public let complete: Bool?
    public let replicaSyncedAt: Double?
    public let replicaAgeMs: Double?
}
public struct CatalogMission: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let status: MissionStatus
    public let tasksDone: Int
    public let tasksTotal: Int
    public let coordinatorSessionId: String?
}
public struct CatalogReplicaMission: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let bindingId: String
    public let projectId: String
    public let missionId: String
    public let missionHome: OperationHost
    public let title: String?
    public let status: MissionStatus?
    public let complete: Bool
    public let sequence: Int
    public let consistency: String
    public let replicaSyncedAt: Double?
    /// Unknown for legacy or missing replicas. Age does not imply execution failure.
    public let replicaAgeMs: Double?

    private enum CodingKeys: String, CodingKey {
        case id, bindingId, projectId, missionId, missionHome, title, status
        case complete, sequence, consistency, replicaSyncedAt, replicaAgeMs
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(bindingId, forKey: .bindingId)
        try values.encode(projectId, forKey: .projectId)
        try values.encode(missionId, forKey: .missionId)
        try values.encode(missionHome, forKey: .missionHome)
        try values.encodeIfPresent(title, forKey: .title)
        try values.encodeIfPresent(status, forKey: .status)
        try values.encode(complete, forKey: .complete)
        try values.encode(sequence, forKey: .sequence)
        try values.encode(consistency, forKey: .consistency)
        try values.encodeIfPresent(replicaSyncedAt, forKey: .replicaSyncedAt)
        // The shared wire contract requires an explicit null for unknown replica age.
        try values.encode(replicaAgeMs, forKey: .replicaAgeMs)
    }
}
public struct CatalogSharedTask: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let bindingId: String
    public let projectId: String
    public let missionId: String
    public let missionHome: OperationHost
    public let source: String
    public let consistency: String
    public let taskId: String?
    public let taskNumber: Int?
    public let title: String?
    public let status: MissionTaskStatus?
    public let proposalId: String?
    public let proposalState: String?
    public let delegationId: String?
    public let executionHost: OperationHost?
    public let executionEpoch: Int?
    public let grantState: String?
    public let running: Bool?
    public let replicaSyncedAt: Double?
    public let replicaAgeMs: Double?
}
