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
    public let legacyControlSessionId: String?
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
    public init(schemaVersion: Int = 1, bindingId: String, generation: UInt64,
                home: OperationHost, executor: OperationHost, state: State) {
        self.schemaVersion = schemaVersion; self.bindingId = bindingId; self.generation = generation
        self.home = home; self.executor = executor; self.state = state
    }
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
public struct ControlHomeEnrollmentRequest: Codable, Equatable, Sendable {
    public let enrollment: ControlHomeEnrollment
    public let peerHello: DaemonHello
    /// Explicit null asserts that no enrollment is present. Unlike other optional fields, null is required.
    public let expectedGeneration: UInt64?
    public init(enrollment: ControlHomeEnrollment, peerHello: DaemonHello, expectedGeneration: UInt64?) {
        self.enrollment = enrollment; self.expectedGeneration = expectedGeneration
        self.peerHello = peerHello
    }
    private enum CodingKeys: String, CodingKey { case enrollment, peerHello, expectedGeneration }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enrollment = try values.decode(ControlHomeEnrollment.self, forKey: .enrollment)
        peerHello = try values.decode(DaemonHello.self, forKey: .peerHello)
        expectedGeneration = try values.decode(UInt64?.self, forKey: .expectedGeneration)
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(enrollment, forKey: .enrollment)
        try values.encode(peerHello, forKey: .peerHello)
        try values.encode(expectedGeneration, forKey: .expectedGeneration)
    }
}
public struct ControlHostStateResponse: Codable, Equatable, Sendable {
    public let configuration: ControlHostConfiguration
    public let enrollment: ControlHomeEnrollment
    public let peerHello: DaemonHello
    public let cutover: ControlHostCutover?
}
public struct ControlArchiveRequest: Codable, Equatable, Sendable {
    public let expectedGeneration: UInt64
    public let sessionId: String
    public let idempotencyKey: String
    public init(expectedGeneration: UInt64, sessionId: String, idempotencyKey: String) {
        self.expectedGeneration = expectedGeneration; self.sessionId = sessionId
        self.idempotencyKey = idempotencyKey
    }
}
public struct ControlArchiveOperationPayload: Codable, Equatable, Sendable {
    public let idempotencyKey: String
    public let sessionId: String
    public let readiness: ControlHostCutover
}
public struct ControlArchiveResponse: Codable, Equatable, Sendable {
    public let operation: ControlDurableOperation
}
public struct ControlArchiveResult: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case archive = "control.archive" }
    public let kind: Kind
    public let configuration: ControlHostConfiguration
    public let cutover: ControlHostCutover
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
    /// App-triggered administrative transition, not a pilot tool action.
    case archive = "control.archive"
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
    /// Adapt without re-encoding payload bytes or replacing operation identity.
    public var durableOperation: DurableOperation {
        DurableOperation(schemaVersion: schemaVersion, operationId: operationId, producerId: producerId,
                         sequence: sequence, origin: origin.envelopeIdentity, destination: destination.envelopeIdentity,
                         kind: kind.rawValue, targetId: targetId, payload: payload, payloadHash: payloadHash,
                         bindingId: bindingId, bindingGeneration: bindingGeneration)
    }
}
public struct ControlOperationResult: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case start = "control.start", send = "control.send", run = "control.run"
        case watch = "control.watch", unwatch = "control.unwatch", revoke = "control.revoke"
    }
    public let kind: Kind
    public let authorizationId: String
    public let sessionId: String?
    public let watchId: String?
    public let removed: Bool?
    public let revokedAt: Double?
}
public struct ControlOperationExchangeRequest: Codable, Equatable, Sendable {
    public let peer: OperationHost
    public let cursor: String?
    public init(peer: OperationHost, cursor: String? = nil) { self.peer = peer; self.cursor = cursor }
}
public struct ControlOperationExchangeResponse: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let operations: [ControlDurableOperation]
    public let more: Bool
    public let next: String?
}
public struct ControlOperationAcknowledgment: Codable, Equatable, Sendable {
    public let operation: ControlDurableOperation
    public let receipt: OperationReceipt
    public init(operation: ControlDurableOperation, receipt: OperationReceipt) {
        self.operation = operation; self.receipt = receipt
    }
}
public struct ControlReceiptAdoptionResponse: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case accepted, rejected }
    public let operationId: String
    public let state: State
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
public struct ControlRemoteEventQuery: Codable, Equatable, Sendable {
    public let after: Int
    public let limit: Int?
    public init(after: Int, limit: Int? = nil) { self.after = after; self.limit = limit }
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
public struct ControlRemoteStatusQuery: Codable, Equatable, Sendable {
    public let cursor: String?
    public init(cursor: String? = nil) { self.cursor = cursor }
}
public struct ControlRemoteStatusImportResponse: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case staged, published }
    public let snapshotId: String
    public let state: State
    public let next: String?
}
