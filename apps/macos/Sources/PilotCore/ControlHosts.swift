import Foundation

/// Contract-only mirrors of packages/protocol/src/control.ts. No enrollment, routing or execution is enabled.
public enum ControlDaemonRole: String, Codable, CaseIterable, Sendable {
    case home, executor
    case archivedControl = "archived-control"
}
public struct ControlHostConfiguration: Codable, Equatable, Sendable {
    public struct Archive: Codable, Equatable, Sendable {
        public let sessionId: String
        public let archivedAt: Double
    }
    public let schemaVersion: Int
    public let home: OperationHost
    public let host: OperationHost
    public let role: ControlDaemonRole
    public let controlSessionId: String?
    public let archive: Archive?
}
public struct ControlHomeEnrollment: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case active, revoked }
    public let schemaVersion: Int
    public let bindingId: String
    public let generation: UInt64
    public let home: OperationHost
    public let executor: OperationHost
    public let state: State
}
public struct ControlHostCutover: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case preparing, ready, archived }
    public let bindingId: String
    public let generation: UInt64
    public let contractVersion: Int
    public let home: OperationHost
    public let executor: OperationHost
    public let state: State
    public let homeReady: Bool
    public let executorEnrolled: Bool
    public let actionReceiptOperationId: String?
    public let watchEventId: String?
    public let taskSnapshotId: String?
    public let updatedAt: Double
}
public enum ControlPilotAction: String, Codable, CaseIterable, Sendable {
    case status, health, logs, telemetry, read, checks, authorize, authorizations, revoke
    case resolveAuthorization = "resolve_authorization"
    case start, send, stop, pause, resume, redirect
    case missionCreate = "mission_create", missionAttach = "mission_attach"
    case watch, unwatch, watches
}
public struct ControlHostRequest: Codable, Equatable, Sendable {
    public let action: ControlPilotAction
    public let host: OperationHost?
    public let args: [String: JSONValue]
}
public struct ControlBudgetReservation: Codable, Equatable, Sendable {
    public let reservationId: String
    public let budgetUsd: Double
    public let followUps: Int
}
public struct ControlOperationAuthority: Codable, Equatable, Sendable {
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
}
public enum ControlStartTarget: Codable, Equatable, Sendable {
    case project(projectId: String)
    case task(missionId: String, taskId: String)
    private enum CodingKeys: String, CodingKey { case kind, projectId, missionId, taskId }
    private enum Kind: String, Codable { case project, task }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .kind) {
        case .project: self = .project(projectId: try values.decode(String.self, forKey: .projectId))
        case .task: self = .task(missionId: try values.decode(String.self, forKey: .missionId),
                                 taskId: try values.decode(String.self, forKey: .taskId))
        }
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .project(projectId):
            try values.encode(Kind.project, forKey: .kind)
            try values.encode(projectId, forKey: .projectId)
        case let .task(missionId, taskId):
            try values.encode(Kind.task, forKey: .kind)
            try values.encode(missionId, forKey: .missionId)
            try values.encode(taskId, forKey: .taskId)
        }
    }
}
public struct ControlStartOperationPayload: Codable, Equatable, Sendable {
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
    public let target: ControlStartTarget
    public let message: String
    public let model: String
    public let thinking: String?
}
public struct ControlSendOperationPayload: Codable, Equatable, Sendable {
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
    public let sessionId: String
    public let message: String
    public let direct: Bool?
}
public struct ControlRunOperationPayload: Codable, Equatable, Sendable {
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
    public enum Action: String, Codable, CaseIterable, Sendable { case stop, pause, resume, redirect }
    public let sessionId: String
    public let direct: Bool?
    public let action: Action
    /// Required only for redirect. Admission validates this conditional field.
    public let message: String?
}
public struct ControlWatchOperationPayload: Codable, Equatable, Sendable {
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
    public let watch: WatchInput
}
public struct ControlUnwatchOperationPayload: Codable, Equatable, Sendable {
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
    public let watchId: String
}
public struct ControlRevokeOperationPayload: Codable, Equatable, Sendable {
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
    public let revokedAt: Double
}
public enum ControlOperationKind: String, Codable, CaseIterable, Sendable {
    case start = "control.start", send = "control.send", run = "control.run"
    case watch = "control.watch", unwatch = "control.unwatch", revoke = "control.revoke"
}
/// The same immutable envelope, with a closed kind. Payload is never reserialized by the courier.
public struct ControlDurableOperation: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let operationId: String
    public let producerId: String
    public let sequence: Int
    public let origin: OperationHost
    public let destination: OperationHost
    public let kind: ControlOperationKind
    public let targetId: String
    public let payload: String
    public let payloadHash: String
    public let bindingId: String?
    public let bindingGeneration: UInt64?
}
public struct ControlOperationResult: Codable, Equatable, Sendable {
    public let kind: ControlOperationKind
    public let authorizationId: String
    public let sessionId: String?
    public let watchId: String?
    public let removed: Bool?
    public let revokedAt: Double?
}
public struct ControlOperationExchangeRequest: Codable, Equatable, Sendable {
    public let peer: OperationHost
}
public struct ControlOperationExchangeResponse: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let operations: [ControlDurableOperation]
    public let more: Bool
}
public struct ControlOperationAcknowledgment: Codable, Equatable, Sendable {
    public let operation: ControlDurableOperation
    public let receipt: OperationReceipt
}
public struct ControlUntrustedResultTail: Codable, Equatable, Sendable {
    public let untrusted: Bool
    public let text: String
    public let truncated: Bool
}
public enum ControlRemoteEventKind: String, Codable, CaseIterable, Sendable {
    case chatSettled = "chat.settled", chatFailed = "chat.failed", chatResult = "chat.result"
    case prMerged = "pr.merged", prClosed = "pr.closed", prReady = "pr.ready"
    case linearDone = "linear.done", missionTaskDone = "mission.task_done", missionDone = "mission.done"
    case watchRemoved = "watch.removed"
}
public struct ControlRemoteEvent: Codable, Equatable, Sendable {
    public let sourceHost: OperationHost
    public let eventId: String
    public let cursor: Int
    public let watchId: String
    public let authorizationId: String
    public let kind: ControlRemoteEventKind
    public let occurredAt: Double
    public let watch: Watch
    public let operationId: String?
    public let sessionId: String?
    public let resultTail: ControlUntrustedResultTail?
}
public struct ControlRemoteEventPage: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let sourceHost: OperationHost
    public let after: Int
    public let head: Int
    public let events: [ControlRemoteEvent]
    public let next: Int?
}
public struct ControlRemoteEventAcknowledgment: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let sourceHost: OperationHost
    public let through: Int
    public let eventId: String
}
public struct ControlRemoteMissionTask: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case offered, accepted, sealed
        case cancelRequested = "cancel-requested"
    }
    public enum Context: String, Codable, Sendable { case committed, provisional }
    public let missionHome: OperationHost
    public let missionId: String
    public let taskId: String
    public let executionHost: OperationHost
    public let epoch: Int
    public let state: State
    public let context: Context
}
public struct ControlRemoteStatusSnapshot: Codable, Equatable, Sendable {
    public let sourceHost: OperationHost
    public let snapshotId: String
    public let capturedAt: Double
    public let dashboard: ControlDashboardResponse
    public let missionTasks: [ControlRemoteMissionTask]
    public let missionTasksTotal: Int
    public let truncated: Bool
}
public struct ControlRemoteStatusPage: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let snapshot: ControlRemoteStatusSnapshot
    public let next: String?
}
