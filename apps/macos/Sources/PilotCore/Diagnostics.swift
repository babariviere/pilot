import Foundation

/// Mirrors packages/protocol/src/diagnostics.ts. Diagnostic payloads contain only bounded operational fields.
public enum DiagnosticFreshness: String, Codable, Sendable { case fresh, stale, unavailable }
public enum DiagnosticSource: String, Codable, Sendable { case lifecycle, requestTiming = "request_timing", daemon }
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

/// Closed fields shared by lifecycle, request-timing and daemon-stall evidence.
public struct DiagnosticEvidence: Codable, Sendable {
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
    public let durationMs: Double?
    public let cpuMs: Double?
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
    public let sources: [DiagnosticSourceStatus]
    public let evidence: [DiagnosticEvidence]
    public let truncation: SessionDiagnosticTruncation
}
