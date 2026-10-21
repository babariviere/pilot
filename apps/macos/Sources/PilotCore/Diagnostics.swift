import Foundation

/// Mirrors packages/protocol/src/diagnostics.ts. Diagnostic payloads contain only bounded operational fields.
public enum DiagnosticFreshness: String, Codable, Sendable { case fresh, stale, unavailable }
public enum DiagnosticSource: String, Codable, Sendable {
    case lifecycle, requestTiming = "request_timing", tool, daemon, os, app
}
public enum DiagnosticPauseReason: String, Codable, Sendable { case sleep, update, quota, connectivity, user }
public enum DiagnosticErrorCode: String, Codable, Sendable {
    case startupFailure = "startup_failure"
    case admissionUncertain = "admission_uncertain"
    case workerFailure = "worker_failure"
    case recoveryPending = "recovery_pending"
    case unknown
}

public struct DiagnosticSourceStatus: Codable, Sendable {
    public let source: DiagnosticSource
    public let freshness: DiagnosticFreshness
    public let observedAt: String?
    public let available: Int
    public let invalid: Int
    public let truncated: Bool
}

/// Closed fields shared by lifecycle, request-timing, tool, daemon-stall and native OS evidence.
public struct DiagnosticEvidence: Codable, Sendable {
    public let health: DiagnosticHostHealth?
    public let ref: String
    public let source: DiagnosticSource
    public let at: String
    public let kind: String
    public let reason: String?
    public let state: String?
    public let droppedBefore: Int?
    public let outcome: String?
    public let requestSource: String?
    public let preparationMs: Double?
    public let providerMs: Double?
    public let totalMs: Double?
    public let toolToPreparationMs: Double?
    public let payloadReadyMs: Double?
    public let httpDispatchMs: Double?
    public let responseHeadersMs: Double?
    public let firstProviderEventMs: Double?
    public let firstContentMs: Double?
    public let firstThinkingMs: Double?
    public let firstTextMs: Double?
    public let firstToolCallMs: Double?
    public let httpAttempts: Int?
    public let windowMs: Double?
    public let releaseRelation: String?
    public let durationMs: Double?
    public let cpuMs: Double?
    public let category: String?
    public let nested: Bool?
    public let waitKind: String?
    public let assessment: String?
    public let thresholdMs: Double?
    public let progressAgeMs: Double?
    public let livenessAgeMs: Double?
    public let dispatchMs: Double?
    public let executionMs: Double?
    public let cancellationWaitMs: Double?
    public let attemptRef: String?
    public let stage: String?
    public let sequence: Int?
}

public enum DevboxSetupDiagnosticStage: String, Codable, CaseIterable, Sendable {
    case configuration, package, sshTransport = "ssh_transport", remoteBootstrap = "remote_bootstrap"
    case remoteHandshake = "remote_handshake", enrollment, adoption
}

public enum DevboxSetupDiagnosticOutcome: String, Codable, Sendable {
    case started, succeeded, failed, cancelled
}

public enum DevboxSetupDiagnosticReason: String, Codable, Sendable {
    case invalidConfiguration = "invalid_configuration"
    case packageUnavailable = "package_unavailable", packageUntrusted = "package_untrusted"
    case sshTimeout = "ssh_timeout", sshLaunchFailed = "ssh_launch_failed"
    case sshTransportUnknown = "ssh_transport_unknown", remotePrerequisite = "remote_prerequisite"
    case remoteSetup = "remote_setup", remoteIdentity = "remote_identity", identityChanged = "identity_changed"
    case incompatible, sandboxUnavailable = "sandbox_unavailable", handshakeRejected = "handshake_rejected"
    case enrollmentFailed = "enrollment_failed", adoptionFailed = "adoption_failed", cancelled, unknown
}

/// Content-free metadata from macOS MetricKit or the app-owned devbox setup timeline.
public struct NativeDiagnosticEvidence: Codable, Equatable, Sendable {
    public let ref: String
    public let source: DiagnosticSource
    public let at: String
    public let kind: String
    public let reason: String?
    public let windowMs: Double?
    public let releaseRelation: String?
    public let durationMs: Double?
    public let sequence: Int?
    public let outcome: String?

    public init(ref: String, at: String, kind: String, reason: String, windowMs: Double, releaseRelation: String,
                durationMs: Double? = nil) {
        self.ref = ref
        source = .os
        self.at = at
        self.kind = kind
        self.reason = reason
        self.windowMs = windowMs
        self.releaseRelation = releaseRelation
        self.durationMs = durationMs
        attemptRef = nil
        sequence = nil
        stage = nil
        outcome = nil
    }

    public init(ref: String, attemptRef: String, sequence: Int, at: String, stage: DevboxSetupDiagnosticStage,
                outcome: DevboxSetupDiagnosticOutcome, reason: DevboxSetupDiagnosticReason? = nil) {
        self.ref = ref
        self.attemptRef = attemptRef
        self.sequence = sequence
        source = .app
        self.at = at
        kind = "devbox.setup"
        self.stage = stage.rawValue
        self.outcome = outcome.rawValue
        self.reason = reason?.rawValue
        windowMs = nil
        releaseRelation = nil
        durationMs = nil
    }
}

public struct NativeDiagnosticsBatch: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let evidence: [NativeDiagnosticEvidence]
    public let dropped: Int

    public init(evidence: [NativeDiagnosticEvidence], dropped: Int) {
        schemaVersion = 1
        self.evidence = evidence
        self.dropped = dropped
    }
}

public struct SessionDiagnosticQueue: Codable, Sendable {
    public let pendingInputs: Int
    public let starting: Bool
    public let parking: Bool
    public let workspacePreparing: Bool
    public let runningJobs: Int
    public let workingSubagents: Int
}

public struct SessionDiagnosticCurrent: Codable, Sendable {
    public let state: String
    public let working: Bool
    public let pauses: [DiagnosticPauseReason]
    public let recovery: String
    public let hasError: Bool
    public let errorCode: DiagnosticErrorCode?
    public let queue: SessionDiagnosticQueue
}

public struct SessionDiagnosticResources: Codable, Sendable {
    public let daemonUptimeMs: Double?
    public let eventLoopUtilization: Double?
    public let eventLoopDelayP99Ms: Double?
    public let inFlightRequests: Int?
    public let rssBytes: Int?
    public let heapUsedBytes: Int?
}

public struct SessionDiagnosticTruncation: Codable, Sendable {
    public let truncated: Bool
    public let returned: Int
    public let available: Int
    public let dropped: Int
    public let invalid: Int
    public let encodedBytes: Int
    public let maxItems: Int
    public let maxBytes: Int
}

public struct SessionDiagnostics: Codable, Sendable {
    public let featureUsage: FeatureUsageSnapshot?
    public struct Connectivity: Codable, Sendable {
        public let state: String
        public let observedAt: String?
    }

    public let schemaVersion: Int
    public let host: HostRef
    public let sessionId: String
    public let release: String
    public let collectedAt: String
    public let freshness: DiagnosticFreshness
    public let connectivity: Connectivity
    public let current: SessionDiagnosticCurrent
    public let resources: SessionDiagnosticResources
    public let ai: AIUsageAccounting?
    public let aiBudget: AIUsageBudgetComparison?
    public let sources: [DiagnosticSourceStatus]
    public let evidence: [DiagnosticEvidence]
    public let truncation: SessionDiagnosticTruncation
}

/// Host/app diagnostics with no attached chat or transcript authority.
public struct AppDiagnostics: Codable, Sendable {
    public let featureUsage: FeatureUsageSnapshot?
    public struct Connectivity: Codable, Sendable {
        public let state: String
        public let observedAt: String?
    }
    public struct LocalDiagnostics: Codable, Sendable {
        public let enabled: Bool
        public let coverage: String
    }
    public struct Sessions: Codable, Sendable {
        public let total: Int
        public let active: Int
        public let archived: Int
        public let working: Int
        public let failed: Int
        public let workers: Int
    }

    public let schemaVersion: Int
    public let scope: DiagnosticScope
    public let host: HostRef
    public let release: String
    public let collectedAt: String
    public let connectivity: Connectivity
    public let localDiagnostics: LocalDiagnostics
    public let sessions: Sessions
    public let resources: SessionDiagnosticResources
}

public enum DiagnosticRepairUncertainty: String, Codable, CaseIterable, Hashable, Sendable {
    case low, medium, high
}

public struct DiagnosticRepairProposal: Codable, Equatable, Hashable, Sendable {
    public let subject: DiagnosticEvidenceSubject?
    public let repairTitle: String?
    public let schemaVersion: Int
    public let id: String
    public let targetSessionId: String?
    public let createdAt: String
    public let evidenceRefs: [String]
    public let findings: String
    public let uncertainty: DiagnosticRepairUncertainty
    public let suggestedRepair: String
    public let regressionTestGuidance: String

    public init(schemaVersion: Int = 1, id: String, targetSessionId: String? = nil, createdAt: String,
                evidenceRefs: [String], findings: String, uncertainty: DiagnosticRepairUncertainty,
                suggestedRepair: String, regressionTestGuidance: String,
                subject: DiagnosticEvidenceSubject? = nil, repairTitle: String? = nil) {
        self.subject = subject; self.repairTitle = repairTitle
        self.schemaVersion = schemaVersion
        self.id = id
        self.targetSessionId = targetSessionId
        self.createdAt = createdAt
        self.evidenceRefs = evidenceRefs
        self.findings = findings
        self.uncertainty = uncertainty
        self.suggestedRepair = suggestedRepair
        self.regressionTestGuidance = regressionTestGuidance
    }
}

public struct DiagnosticsHandoffRequest: Codable, Sendable {
    public let targetSessionId: String?
    public let subject: DiagnosticEvidenceSubject?
    public let repairTitle: String?
    public let proposalId: String
    public let findings: String
    public let uncertainty: DiagnosticRepairUncertainty
    public let suggestedRepair: String
    public let regressionTestGuidance: String

    public init(targetSessionId: String? = nil, proposalId: String, findings: String,
                uncertainty: DiagnosticRepairUncertainty, suggestedRepair: String,
                regressionTestGuidance: String, subject: DiagnosticEvidenceSubject? = nil, repairTitle: String? = nil) {
        self.subject = subject; self.repairTitle = repairTitle
        self.targetSessionId = targetSessionId
        self.proposalId = proposalId
        self.findings = findings
        self.uncertainty = uncertainty
        self.suggestedRepair = suggestedRepair
        self.regressionTestGuidance = regressionTestGuidance
    }
}

/// Bounded material for a user-authorized repair chat. Producing it never starts or changes a chat.
public struct DiagnosticsHandoff: Codable, Sendable {
    public let schemaVersion: Int
    public let host: OperationHost
    public let targetSessionId: String?
    public let subject: DiagnosticEvidenceSubject?
    public let repairTitle: String?
    public let sourceProjectId: String?
    public let projectId: String?
    public let evidence: [DiagnosticEvidence]
    public let proposalId: String
    public let findings: String
    public let uncertainty: DiagnosticRepairUncertainty
    public let suggestedRepair: String
    public let regressionTestGuidance: String
}
