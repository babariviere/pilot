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
    public let roleEpoch: Int
    public let stagedRole: ControlStagedRole?
    public let freeze: ControlFreezeIntent?
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
    public let roleFence: ControlRoleFence
    public let compatibleRoutes: Bool
    public let archiveReady: Bool
    public let acceptance: ControlAcceptanceProof?
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
    public let approvalRequestId: String
    public let expectedRoleEpoch: Int
    public let peerHello: DaemonHello
    /// Explicit null asserts that no enrollment is present. Unlike other optional fields, null is required.
    public let expectedGeneration: UInt64?
    public init(enrollment: ControlHomeEnrollment, peerHello: DaemonHello, expectedGeneration: UInt64?,
                approvalRequestId: String, expectedRoleEpoch: Int) {
        self.enrollment = enrollment; self.expectedGeneration = expectedGeneration
        self.peerHello = peerHello
        self.approvalRequestId = approvalRequestId; self.expectedRoleEpoch = expectedRoleEpoch
    }
    private enum CodingKeys: String, CodingKey {
        case enrollment, peerHello, expectedGeneration, approvalRequestId, expectedRoleEpoch
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enrollment = try values.decode(ControlHomeEnrollment.self, forKey: .enrollment)
        peerHello = try values.decode(DaemonHello.self, forKey: .peerHello)
        approvalRequestId = try values.decode(String.self, forKey: .approvalRequestId)
        expectedRoleEpoch = try values.decode(Int.self, forKey: .expectedRoleEpoch)
        expectedGeneration = try values.decode(UInt64?.self, forKey: .expectedGeneration)
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(enrollment, forKey: .enrollment)
        try values.encode(peerHello, forKey: .peerHello)
        try values.encode(approvalRequestId, forKey: .approvalRequestId)
        try values.encode(expectedRoleEpoch, forKey: .expectedRoleEpoch)
        try values.encode(expectedGeneration, forKey: .expectedGeneration)
    }
}
public struct ControlHostStateResponse: Codable, Equatable, Sendable {
    public let configuration: ControlHostConfiguration
    public let enrollment: ControlHomeEnrollment
    public let peerHello: DaemonHello
    public let cutover: ControlHostCutover?
    public let roleAcknowledgments: [ControlRoleAcknowledgment]?
    public let courierCapability: ControlCourierCapability?
    public let pairing: ControlPairingState?
    public let mutation: ControlMutationResult?
}
public struct ControlArchiveRequest: Codable, Equatable, Sendable {
    public let approvalRequestId: String
    public let expectedRoleEpoch: Int
    public let expectedGeneration: UInt64
    public let sessionId: String
    public let idempotencyKey: String
    public init(expectedGeneration: UInt64, sessionId: String, idempotencyKey: String,
                approvalRequestId: String, expectedRoleEpoch: Int) {
        self.expectedGeneration = expectedGeneration; self.sessionId = sessionId
        self.idempotencyKey = idempotencyKey
        self.approvalRequestId = approvalRequestId; self.expectedRoleEpoch = expectedRoleEpoch
    }
}
public struct ControlArchiveOperationPayload: Codable, Equatable, Sendable {
    public let roleFence: ControlRoleFence
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
    public let roleAcknowledgment: ControlRoleAcknowledgment
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
    public let roleFence: ControlRoleFence
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
}
public enum ControlStartTarget: Codable, Equatable, Sendable {
    case project(projectId: String)
    case task(missionId: String, taskId: String, delegation: ControlDelegationFence)
    private enum CodingKeys: String, CodingKey { case kind, projectId, missionId, taskId, delegation }
    private enum Kind: String, Codable { case project, task }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .kind) {
        case .project: self = .project(projectId: try values.decode(String.self, forKey: .projectId))
        case .task: self = .task(missionId: try values.decode(String.self, forKey: .missionId),
                                 taskId: try values.decode(String.self, forKey: .taskId),
                                 delegation: try values.decode(ControlDelegationFence.self, forKey: .delegation))
        }
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .project(projectId):
            try values.encode(Kind.project, forKey: .kind)
            try values.encode(projectId, forKey: .projectId)
        case let .task(missionId, taskId, delegation):
            try values.encode(Kind.task, forKey: .kind)
            try values.encode(missionId, forKey: .missionId)
            try values.encode(taskId, forKey: .taskId)
            try values.encode(delegation, forKey: .delegation)
        }
    }
}
public struct ControlStartOperationPayload: Codable, Equatable, Sendable {
    public let roleFence: ControlRoleFence
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
    public let roleFence: ControlRoleFence
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
    public let roleFence: ControlRoleFence
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
    public let roleFence: ControlRoleFence
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
    public let watch: WatchInput
}
public struct ControlUnwatchOperationPayload: Codable, Equatable, Sendable {
    public let roleFence: ControlRoleFence
    public let authorizationId: String
    public let levelCeiling: ControlAuthorizationLevel
    public let budgetReservation: ControlBudgetReservation
    public let idempotencyKey: String
    public let authorization: ControlAuthorization
    public let watchId: String
}
public struct ControlRevokeOperationPayload: Codable, Equatable, Sendable {
    public let roleFence: ControlRoleFence
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
    public let lane: ControlOperationExchangeResponse.Lane?
    public let cursor: String?
    public init(peer: OperationHost, cursor: String? = nil, lane: ControlOperationExchangeResponse.Lane? = nil) {
        self.peer = peer; self.cursor = cursor; self.lane = lane
    }
}
public struct ControlOperationExchangeResponse: Codable, Equatable, Sendable {
    public enum Lane: String, Codable, Sendable { case revocation, ordinary }
    public let bindingId: String
    public let generation: UInt64
    public let lane: Lane
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
    public let roleAcknowledgment: ControlRoleAcknowledgment?
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
    public let acknowledgedThrough: Int
    public let acknowledgedEventId: String?
    public let events: [ControlRemoteEvent]
    public let next: Int?
}
public struct ControlRemoteEventAcknowledgment: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let sourceHost: OperationHost
    public let through: Int
    public let eventId: String?
}
public struct ControlRemoteEventQuery: Codable, Equatable, Sendable {
    public let after: Int
    public let limit: Int?
    public init(after: Int, limit: Int? = nil) { self.after = after; self.limit = limit }
}
public typealias ControlRemoteMissionTask = ControlDashboardSharedTask
public struct ControlRemoteStatusSnapshot: Codable, Equatable, Sendable {
    public let sourceHost: OperationHost
    public let snapshotId: String
    public let revision: Int
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
public struct ControlRemoteStatusImportRequest: Codable, Equatable, Sendable {
    public let page: ControlRemoteStatusPage
    public let expectedPublishedRevision: Int
    public init(page: ControlRemoteStatusPage, expectedPublishedRevision: Int) {
        self.page = page; self.expectedPublishedRevision = expectedPublishedRevision
    }
}
public struct ControlRemoteStatusImportResponse: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case staged, published }
    public let snapshotId: String
    public let state: State
    public let publishedRevision: Int
    public let next: String?
}

public struct ControlRoleFence: Codable, Equatable, Sendable {
    public let home: Int
    public let executor: Int
    public init(home: Int, executor: Int) { self.home = home; self.executor = executor }
}
public struct ControlAcceptanceProof: Codable, Equatable, Sendable {
    public let suite: String
    public let homeBuildId: String
    public let executorBuildId: String
    public let daemonProofId: String
    public let realCourier: ControlRealCourierProof?
}
public struct ControlRealCourierProof: Codable, Equatable, Sendable {
    public let suite: String
    public let appBuildId: String
    public let proofId: String
}
public struct ControlRoleAcknowledgment: Codable, Equatable, Sendable {
    public let contractVersion: Int
    public let bindingId: String
    public let generation: UInt64
    public let home: OperationHost
    public let host: OperationHost
    public let role: ControlDaemonRole
    public let roleEpoch: Int
    public let intentId: String
    public let sessionId: String?
    public let archivedAt: Double?
}
public struct ControlArchivedWatch: Codable, Equatable, Sendable {
    public enum Disposition: String, Codable, Sendable { case stopped, fired }
    public let watch: Watch
    public let disposition: Disposition
    public let stoppedAt: Double?
    public let auditReason: String?
}
public struct ControlArchivedWatchesResponse: Codable, Equatable, Sendable {
    public let watches: [ControlArchivedWatch]
    public let next: String?
}
public struct ControlHostInvalidation: Codable, Equatable, Sendable {
    public enum Change: String, Codable, Sendable { case outbox, receipts, events, status, enrollment, readiness, archive, role, reads }
    public let type: String
    public let bindingId: String
    public let generation: UInt64
    public let changes: [Change]
}
public struct ControlHostApprovalInput: Codable, Equatable, Sendable {
    public enum Action: String, Codable, Sendable { case enroll, unpair, archive, bootstrap }
    public let action: Action
    public let appKeyId: String
    public let intentPayload: String
    public init(action: Action, appKeyId: String, intentPayload: String) {
        self.action = action; self.appKeyId = appKeyId; self.intentPayload = intentPayload
    }
}
public struct ControlHostApprovalRequest: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case pending, approved, denied, consumed }
    public let requestId: String
    public let action: ControlHostApprovalInput.Action
    public let appKeyId: String
    public let requestingHost: OperationHost
    public let home: OperationHost
    public let executor: OperationHost
    public let bindingId: String
    public let generation: UInt64
    public let expectedRoleEpoch: Int
    public let intentHash: String
    public let expiresAt: Double
    public let state: State
    public let signingPayload: String
}
public struct ControlHostApprovalDecision: Codable, Equatable, Sendable {
    public let allow: Bool
    public let appKeyId: String
    public let signature: String
    public init(allow: Bool, appKeyId: String, signature: String) {
        self.allow = allow; self.appKeyId = appKeyId; self.signature = signature
    }
}
public struct ControlUnpairRequest: Codable, Equatable, Sendable {
    public let approvalRequestId: String
    public let expectedGeneration: UInt64
    public let expectedRoleEpoch: Int
    public let idempotencyKey: String
    public init(approvalRequestId: String, expectedGeneration: UInt64, expectedRoleEpoch: Int, idempotencyKey: String) {
        self.approvalRequestId = approvalRequestId; self.expectedGeneration = expectedGeneration
        self.expectedRoleEpoch = expectedRoleEpoch; self.idempotencyKey = idempotencyKey
    }
}
public struct ControlUnpairResponse: Codable, Equatable, Sendable {
    public let enrollment: ControlHomeEnrollment
    public let configuration: ControlHostConfiguration
    public let revokedAt: Double
    public let peerAcknowledged: Bool
}
public struct ControlEventImportCursor: Codable, Equatable, Sendable {
    public let sourceHost: OperationHost
    public let importedThrough: Int
    public let lastEventId: String?
    public let acknowledgedThrough: Int
    public let head: Int
}
public struct ControlHostSyncState: Codable, Equatable, Sendable {
    public struct Status: Codable, Equatable, Sendable {
        public let snapshotId: String
        public let revision: Int
        public let publishedRevision: Int
        public let next: String?
        public let state: ControlRemoteStatusImportResponse.State
        public let importedAt: Double
    }
    public let bindingId: String
    public let generation: UInt64
    public let host: OperationHost
    public let events: ControlEventImportCursor
    public let status: Status?
    public let reconciliationRequired: Bool
}
public enum ControlHostAvailability: String, Codable, Sendable { case available, disconnected, unknown }
public struct ControlHostObservation: Codable, Equatable, Sendable {
    public let host: OperationHost
    public let availability: ControlHostAvailability
    public let capturedAt: Double?
    public let importedAt: Double?
    public let snapshotAgeMs: Double?
    private enum CodingKeys: String, CodingKey { case host, availability, capturedAt, importedAt, snapshotAgeMs }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(host, forKey: .host)
        try values.encode(availability, forKey: .availability)
        try values.encodeIfPresent(capturedAt, forKey: .capturedAt)
        try values.encodeIfPresent(importedAt, forKey: .importedAt)
        try values.encode(snapshotAgeMs, forKey: .snapshotAgeMs)
    }
}
public struct ControlTaskConflict: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case pending, conflict, rejected }
    public let proposalId: String?
    public let operationId: String?
    public let origin: SharedSessionRef?
    public let state: State
    public let reason: String?
    public let evidenceId: String?
}
public struct ControlDashboardSharedTask: Codable, Equatable, Sendable {
    public enum Source: String, Codable, Sendable {
        case missionHome = "mission-home", executionFact = "execution-fact", replica, proposal
    }
    public enum Consistency: String, Codable, Sendable { case committed, provisional }
    public let id: String
    public let bindingId: String
    public let bindingGeneration: UInt64
    public let projectId: String
    public let missionId: String
    public let missionHome: OperationHost
    public let observedOn: OperationHost
    public let source: Source
    public let consistency: Consistency
    public let taskId: String?
    public let taskNumber: Int?
    public let title: String?
    public let status: MissionTaskStatus?
    public let definitionRevision: Int?
    public let proposalId: String?
    public let proposalState: ControlTaskConflict.State?
    public let proposalOrigin: SharedSessionRef?
    public let conflicts: [ControlTaskConflict]?
    public let delegationId: String?
    public let grantBindingId: String?
    public let grantBindingGeneration: UInt64?
    public let executionHost: OperationHost?
    public let executionEpoch: Int?
    public let grantState: DelegationGrant.State?
    public let running: Bool?
    public let replicaSyncedAt: Double?
    public let replicaAgeMs: Double?
    public let snapshotCapturedAt: Double?
    public let availability: ControlHostAvailability
}
public struct ControlDashboardReplicaMission: Codable, Equatable, Sendable {
    public enum Consistency: String, Codable, Sendable { case committed }
    public let id: String
    public let bindingId: String
    public let bindingGeneration: UInt64
    public let projectId: String
    public let missionId: String
    public let missionHome: OperationHost
    public let observedOn: OperationHost
    public let title: String?
    public let status: MissionStatus?
    public let complete: Bool
    public let sequence: Int
    public let consistency: Consistency
    public let replicaSyncedAt: Double?
    public let replicaAgeMs: Double?
    public let snapshotCapturedAt: Double?
    public let pendingCount: Int
    public let conflictCount: Int
    public let availability: ControlHostAvailability
    private enum CodingKeys: String, CodingKey {
        case id, bindingId, bindingGeneration, projectId, missionId, missionHome, observedOn, title, status
        case complete, sequence, consistency, replicaSyncedAt, replicaAgeMs, snapshotCapturedAt
        case pendingCount, conflictCount, availability
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(bindingId, forKey: .bindingId)
        try values.encode(bindingGeneration, forKey: .bindingGeneration)
        try values.encode(projectId, forKey: .projectId)
        try values.encode(missionId, forKey: .missionId)
        try values.encode(missionHome, forKey: .missionHome)
        try values.encode(observedOn, forKey: .observedOn)
        try values.encodeIfPresent(title, forKey: .title)
        try values.encodeIfPresent(status, forKey: .status)
        try values.encode(complete, forKey: .complete)
        try values.encode(sequence, forKey: .sequence)
        try values.encode(consistency, forKey: .consistency)
        try values.encodeIfPresent(replicaSyncedAt, forKey: .replicaSyncedAt)
        try values.encode(replicaAgeMs, forKey: .replicaAgeMs)
        try values.encodeIfPresent(snapshotCapturedAt, forKey: .snapshotCapturedAt)
        try values.encode(pendingCount, forKey: .pendingCount)
        try values.encode(conflictCount, forKey: .conflictCount)
        try values.encode(availability, forKey: .availability)
    }
}
public struct ControlArchiveInfo: Codable, Equatable, Sendable {
    public let source: SharedSessionRef
    public let archivedAt: Double
    public let roleEpoch: Int
    public let readOnly: Bool
}
public struct ControlArchiveRead<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let archive: ControlArchiveInfo
    public let value: Value
}
public struct ControlArchiveHistoryPage: Codable, Equatable, Sendable {
    public let entries: [JSONValue]
    public let next: Int?
}
public struct ControlOperationLifecycle: Codable, Equatable, Sendable {
    public enum Delivery: String, Codable, Sendable { case queued, unknown, pending, accepted, rejected }
    public let operationId: String
    public let kind: ControlOperationKind
    public let targetId: String
    public let delivery: Delivery
    public let possiblyTransmitted: Bool
}
public struct ControlHostLifecycleResponse: Codable, Equatable, Sendable {
    public struct Blocker: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable {
            case operation = "control.operation", approval = "control.approval", archive = "control.archive"
            case journal = "control.journal", sync = "control.sync"
        }
        public let kind: Kind
        public let id: String
    }
    public let bindingId: String
    public let generation: UInt64
    public let host: OperationHost
    public let capturedAt: Double
    public let updateReady: Bool
    public let operations: [ControlOperationLifecycle]
    public let blockers: [Blocker]
    public let truncated: Bool
}
public struct ControlHostErrorResponse: Codable, Equatable, Sendable {
    public enum Code: String, Codable, Sendable {
        case invalidRequest = "invalid_request", approvalRequired = "approval_required"
        case approvalExpired = "approval_expired", notFound = "not_found", incompatiblePeer = "incompatible_peer"
        case identityMismatch = "identity_mismatch", staleRole = "stale_role", staleGeneration = "stale_generation"
        case reconciliationRequired = "reconciliation_required", snapshotRestartRequired = "snapshot_restart_required"
        case notReady = "not_ready", capacity
        case staleSnapshot = "stale_snapshot", snapshotCASMismatch = "snapshot_cas_mismatch"
        case cursorGap = "cursor_gap", cursorBeforeFloor = "cursor_before_floor"
        case delegationRequired = "delegation_required", delegationStale = "delegation_stale"
        case delegationSealed = "delegation_sealed", delegationReassigned = "delegation_reassigned"
        case rollbackNotPermitted = "rollback_not_permitted"
        case authenticationRequired = "authentication_required", capabilityDenied = "capability_denied"
        case capabilityExpired = "capability_expired", readUnavailable = "read_unavailable"
        case legacyMigrationRequired = "legacy_migration_required"
    }
    public let code: Code
    public let error: String
    public let syncState: ControlHostSyncState?
    public let checkpoint: ControlRemoteEventCheckpoint?
    public let floor: ControlEventFloor?
    public let current: ControlHostStateResponse?
}

public struct ControlStagedRole: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable { case executor }
    public enum Phase: String, Codable, Sendable { case paired }
    public let home: OperationHost
    public let role: Role
    public let phase: Phase
}
public struct ControlFreezeIntent: Codable, Equatable, Sendable {
    public enum Phase: String, Codable, Sendable { case requested, draining, blocked }
    public let operationId: String
    public let expectedRoleEpoch: Int
    public let phase: Phase
}
public struct ControlDelegationFence: Codable, Equatable, Sendable {
    public let delegationId: String
    public let task: SharedTaskRef
    public let bindingId: String
    public let bindingGeneration: UInt64
    public let executionEpoch: Int
    public let session: SharedSessionRef
    public let target: SharedProjectRef
    public let definitionRevision: Int
    public let context: SharedContextVector
    public let manifestId: String
    public let grantHash: String
    public let placementOperationId: String
}
public struct ControlEnrollmentPreviewRequest: Codable, Equatable, Sendable {
    public let enrollment: ControlHomeEnrollment
    public let expectedRoleEpoch: Int
    public let peerHello: DaemonHello
    public let expectedGeneration: UInt64?
    public init(enrollment: ControlHomeEnrollment, peerHello: DaemonHello,
                expectedGeneration: UInt64?, expectedRoleEpoch: Int) {
        self.enrollment = enrollment; self.peerHello = peerHello
        self.expectedGeneration = expectedGeneration; self.expectedRoleEpoch = expectedRoleEpoch
    }
    private enum CodingKeys: String, CodingKey { case enrollment, expectedRoleEpoch, peerHello, expectedGeneration }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enrollment = try values.decode(ControlHomeEnrollment.self, forKey: .enrollment)
        expectedRoleEpoch = try values.decode(Int.self, forKey: .expectedRoleEpoch)
        peerHello = try values.decode(DaemonHello.self, forKey: .peerHello)
        expectedGeneration = try values.decode(UInt64?.self, forKey: .expectedGeneration)
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(enrollment, forKey: .enrollment)
        try values.encode(expectedRoleEpoch, forKey: .expectedRoleEpoch)
        try values.encode(peerHello, forKey: .peerHello)
        try values.encode(expectedGeneration, forKey: .expectedGeneration)
    }
}
public struct ControlEnrollmentPreviewResponse: Codable, Equatable, Sendable {
    public enum Effect: String, Codable, Sendable { case pairOnly = "pair-only" }
    public let intentPayload: String
    public let intentHash: String
    public let compatible: Bool
    public let effect: Effect
    public let courierScopes: [ControlCourierCapability.Scope]
    public let current: ControlHostStateResponse?
    public let errors: [ControlHostErrorResponse]
}
public struct ControlCourierCapability: Codable, Equatable, Sendable {
    public enum Scope: String, Codable, Sendable {
        case exchange, receipts, events, status, reads, inspect
        case archiveRead = "archive-read"
    }
    public let id: String
    public let bindingId: String
    public let generation: UInt64
    public let home: OperationHost
    public let executor: OperationHost
    public let appKeyId: String
    public let roleFence: ControlRoleFence
    public let expiresAt: Double
    public let scopes: [Scope]
}
public struct ControlCourierAuthentication: Codable, Equatable, Sendable {
    public let signedPayload: String
    public let signature: String
    public init(signedPayload: String, signature: String) {
        self.signedPayload = signedPayload; self.signature = signature
    }
}
public struct ControlCourierCapabilityRefreshRequest: Codable, Equatable, Sendable {
    public let capabilityId: String
    public let expectedRoleEpoch: Int
    public init(capabilityId: String, expectedRoleEpoch: Int) {
        self.capabilityId = capabilityId; self.expectedRoleEpoch = expectedRoleEpoch
    }
}
public struct ControlCourierRequestProof: Codable, Equatable, Sendable {
    public enum Method: String, Codable, Sendable { case get = "GET", post = "POST" }
    public let capabilityId: String
    public let requestId: String
    public let issuedAt: Double
    public let method: Method
    public let path: String
    public let bodyHash: String
    public init(capabilityId: String, requestId: String, issuedAt: Double,
                method: Method, path: String, bodyHash: String) {
        self.capabilityId = capabilityId; self.requestId = requestId; self.issuedAt = issuedAt
        self.method = method; self.path = path; self.bodyHash = bodyHash
    }
}
public struct ControlNativeRequestProof: Codable, Equatable, Sendable {
    public enum Method: String, Codable, Sendable { case get = "GET", post = "POST", put = "PUT" }
    public let appKeyId: String
    public let host: OperationHost
    public let requestId: String
    public let issuedAt: Double
    public let method: Method
    public let path: String
    public let bodyHash: String
    public init(appKeyId: String, host: OperationHost, requestId: String, issuedAt: Double,
                method: Method, path: String, bodyHash: String) {
        self.appKeyId = appKeyId; self.host = host; self.requestId = requestId; self.issuedAt = issuedAt
        self.method = method; self.path = path; self.bodyHash = bodyHash
    }
}
public struct ControlRemoteEventCheckpoint: Codable, Equatable, Sendable {
    public let sourceHost: OperationHost
    public let importedThrough: Int
    public let lastEventId: String?
    public let acknowledgedThrough: Int
    public let head: Int
    public let bindingId: String
    public let generation: UInt64
    public let home: OperationHost
}
public struct ControlEventFloor: Codable, Equatable, Sendable {
    public let bindingId: String
    public let generation: UInt64
    public let sourceHost: OperationHost
    public let through: Int
    public let eventId: String?
}
public enum ControlReadAction: String, Codable, Sendable { case read, health, logs, telemetry, checks }
public struct ControlReadSelectors: Codable, Equatable, Sendable {
    public let sessionId: String?
    public let view: View?
    public enum View: String, Codable, Sendable { case result, tail }
    public let limit: Int?
    public let source: Source?
    public enum Source: String, Codable, Sendable { case daemon, lifecycle, session }
    public let since: String?
    public let q: String?
    public let pr: String?
    public let includeStale: Bool?
}
public struct ControlRemoteReadRequest: Codable, Equatable, Sendable {
    public let requestId: String
    public let host: OperationHost
    public let action: ControlReadAction
    public let selectors: ControlReadSelectors
}
public struct ControlRemoteReadResponse: Codable, Equatable, Sendable {
    public let requestId: String
    public let sourceHost: OperationHost
    public let capturedAt: Double
    public let untrusted: Bool
    public let result: JSONValue
    public let truncated: Bool
    public let availability: ControlHostAvailability
}
public struct ControlReadExchangeRequest: Codable, Equatable, Sendable {
    public let peer: OperationHost
    public let cursor: String?
    public init(peer: OperationHost, cursor: String? = nil) { self.peer = peer; self.cursor = cursor }
}
public struct ControlReadExchangeResponse: Codable, Equatable, Sendable {
    public let requests: [ControlRemoteReadRequest]
    public let next: String?
    public let more: Bool
}
public struct ControlReadImportResponse: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case delivered, expired }
    public let requestId: String
    public let state: State
}
public struct ControlRemoteReadOutcome: Codable, Equatable, Sendable {
    public let requestId: String
    public let host: OperationHost
    public let availability: ControlHostAvailability
    public let response: ControlRemoteReadResponse?
    public let error: ControlHostErrorResponse?
    public init(requestId: String, host: OperationHost, availability: ControlHostAvailability,
                response: ControlRemoteReadResponse? = nil, error: ControlHostErrorResponse? = nil) {
        self.requestId = requestId; self.host = host; self.availability = availability
        self.response = response; self.error = error
    }
}
public struct ControlReadImportRequest: Codable, Equatable, Sendable {
    public let outcome: ControlRemoteReadOutcome
    public init(outcome: ControlRemoteReadOutcome) { self.outcome = outcome }
}

public struct ControlMutationResult: Codable, Equatable, Sendable {
    public enum Disposition: String, Codable, Sendable { case applied, replayed }
    public let disposition: Disposition
    public let intentId: String
}
public struct ControlPairingState: Codable, Equatable, Sendable {
    public enum Phase: String, Codable, Sendable { case partial, paired, revoked }
    public let phase: Phase
    public let localCommitted: Bool
    public let peerCommitted: Bool
}
public struct ControlPairingAcknowledgment: Codable, Equatable, Sendable {
    public let peerRoleAcknowledgment: ControlRoleAcknowledgment
    public let peerHello: DaemonHello
    public init(peerRoleAcknowledgment: ControlRoleAcknowledgment, peerHello: DaemonHello) {
        self.peerRoleAcknowledgment = peerRoleAcknowledgment; self.peerHello = peerHello
    }
}
public enum ControlArchiveLookupDelivery: Codable, Equatable, Sendable {
    case unknown
    case receipt(OperationReceipt)
    private enum CodingKeys: String, CodingKey { case state }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if try values.decode(String.self, forKey: .state) == "unknown" { self = .unknown }
        else { self = .receipt(try OperationReceipt(from: decoder)) }
    }
    public func encode(to encoder: Encoder) throws {
        switch self {
        case .unknown:
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode("unknown", forKey: .state)
        case let .receipt(receipt): try receipt.encode(to: encoder)
        }
    }
}
public struct ControlArchiveLookupResponse: Codable, Equatable, Sendable {
    public let operation: ControlDurableOperation
    public let delivery: ControlArchiveLookupDelivery
    public let adopted: Bool
    public let roleAcknowledgment: ControlRoleAcknowledgment?
}
public struct ControlRoleBootstrapRequest: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable { case home, executor }
    public enum Mode: String, Codable, Sendable { case fresh, preserveLegacy = "preserve-legacy" }
    public let host: OperationHost
    public let home: OperationHost
    public let role: Role
    public let mode: Mode
    public let expectedRoleEpoch: Int
    public let idempotencyKey: String
    public let approvalRequestId: String
    public init(host: OperationHost, home: OperationHost, role: Role, mode: Mode,
                idempotencyKey: String, approvalRequestId: String) {
        self.host = host; self.home = home; self.role = role; self.mode = mode
        expectedRoleEpoch = 0; self.idempotencyKey = idempotencyKey
        self.approvalRequestId = approvalRequestId
    }
}
public struct ControlRoleBootstrapStatus: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case unconfigured, configured
        case legacyMigrationRequired = "legacy-migration-required"
    }
    public let host: OperationHost
    public let state: State
    public let roleEpoch: Int
    public let configuration: ControlHostConfiguration?
    public let roleAcknowledgment: ControlRoleAcknowledgment?
}
public struct ControlRoleBootstrapResult: Codable, Equatable, Sendable {
    public let configuration: ControlHostConfiguration
    public let roleAcknowledgment: ControlRoleAcknowledgment
    public let mutation: ControlMutationResult
}
