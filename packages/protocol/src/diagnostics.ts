import type { OperationHost } from "./operations.ts";

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export type DiagnosticFreshness = "fresh" | "stale" | "unavailable";
export type DiagnosticSource = "lifecycle" | "request_timing" | "tool" | "daemon" | "os" | "app";
export type ToolDiagnosticCategory =
	| "shell"
	| "filesystem"
	| "network"
	| "background"
	| "codemode"
	| "mcp"
	| "orchestration"
	| "other";
export type ToolActivityState = "dispatching" | "running" | "cancelling";
export type ToolActivityOutcome = "success" | "failure" | "timeout" | "cancelled" | "interrupted";
export type ToolWaitKind = "user" | "background" | "child";
export type ToolActivityAssessment =
	| "active"
	| "cancelling"
	| "waiting_user"
	| "waiting_child"
	| "background_work"
	| "paused_sleep"
	| "paused_update"
	| "paused_quota"
	| "paused_connectivity"
	| "paused_user"
	| "suspected_no_progress"
	| "suspected_unresponsive"
	| "suspected_cancellation_delay";

/** Sanitized live kernel state. Raw call IDs, tool names, arguments and results never cross IPC. */
export interface ToolActivityCall {
	ref: string;
	category: ToolDiagnosticCategory;
	nested: boolean;
	waitKind?: ToolWaitKind;
	state: ToolActivityState;
	startedAt: number;
	progressAt: number;
	livenessAt: number;
	cancelRequestedAt?: number;
}

export interface ToolActivitySnapshot {
	enabled: boolean;
	observedAt: number;
	calls: ToolActivityCall[];
	dropped: number;
}
export type DiagnosticPauseReason = "sleep" | "update" | "quota" | "connectivity" | "user";
export type DiagnosticErrorCode =
	| "startup_failure"
	| "admission_uncertain"
	| "worker_failure"
	| "recovery_pending"
	| "unknown";

export interface DiagnosticSourceStatus {
	source: DiagnosticSource;
	freshness: DiagnosticFreshness;
	/** UTC observation time of the newest retained item. */
	observedAt?: string;
	available: number;
	invalid: number;
	truncated: boolean;
}

export interface LifecycleDiagnosticEvidence {
	ref: string;
	source: "lifecycle";
	at: string;
	kind: string;
	reason: string;
	state: string;
	droppedBefore?: number;
}

export interface RequestTimingDiagnosticEvidence {
	ref: string;
	source: "request_timing";
	at: string;
	kind: "model.request";
	outcome: "completed" | "error" | "aborted";
	requestSource: "generation" | "stream";
	preparationMs: number;
	providerMs: number;
	totalMs: number;
	toolToPreparationMs?: number;
	payloadReadyMs?: number;
	httpDispatchMs?: number;
	responseHeadersMs?: number;
	firstProviderEventMs?: number;
	firstContentMs?: number;
	firstThinkingMs?: number;
	firstTextMs?: number;
	firstToolCallMs?: number;
	httpAttempts: number;
	droppedBefore?: number;
}

export interface StallDiagnosticEvidence {
	ref: string;
	source: "daemon";
	at: string;
	kind: "event_loop.stall";
	reason: "synchronous_work" | "waiting" | "sleep";
	durationMs: number;
	cpuMs?: number;
}

/** Content-free app health observed on demand. Not proof of an unobserved failure or its cause. */
export interface HostSnapshotDiagnosticEvidence {
	ref: string;
	source: "daemon";
	at: string;
	kind: "host.snapshot";
	health: {
		totalSessions: number;
		activeSessions: number;
		workingSessions: number;
		failedSessions: number;
		archivedSessions: number;
		rssBytes?: number;
		heapUsedBytes?: number;
	};
}

export interface ToolInFlightDiagnosticEvidence {
	ref: string;
	source: "tool";
	at: string;
	kind: "tool.in_flight";
	category: ToolDiagnosticCategory;
	nested: boolean;
	waitKind?: ToolWaitKind;
	state: ToolActivityState;
	assessment: ToolActivityAssessment;
	thresholdMs?: number;
	durationMs: number;
	progressAgeMs: number;
	livenessAgeMs: number;
	cancellationWaitMs?: number;
}

export interface ToolCallDiagnosticEvidence {
	ref: string;
	source: "tool";
	at: string;
	kind: "tool.call";
	category: ToolDiagnosticCategory;
	nested: boolean;
	outcome: ToolActivityOutcome;
	durationMs: number;
	dispatchMs?: number;
	executionMs?: number;
	cancellationWaitMs?: number;
	droppedBefore?: number;
}

/** Content-free metadata delivered by macOS MetricKit. Report bodies and call stacks never enter Pilot. */
export interface NativeDiagnosticEvidence {
	ref: string;
	source: "os";
	at: string;
	kind: "native.crash" | "native.hang";
	reason: "process_exit" | "unresponsive";
	/** MetricKit payload observation window ending at `at`; this is not an exact incident timestamp. */
	windowMs: number;
	releaseRelation: "current" | "other_or_unknown";
	durationMs?: number;
}

export type DevboxSetupDiagnosticStage =
	| "configuration"
	| "package"
	| "ssh_transport"
	| "remote_bootstrap"
	| "remote_handshake"
	| "enrollment"
	| "adoption";
export type DevboxSetupDiagnosticOutcome = "started" | "succeeded" | "failed" | "cancelled";
export type DevboxSetupDiagnosticReason =
	| "invalid_configuration"
	| "package_unavailable"
	| "package_untrusted"
	| "ssh_timeout"
	| "ssh_launch_failed"
	| "ssh_transport_unknown"
	| "remote_prerequisite"
	| "remote_setup"
	| "remote_identity"
	| "identity_changed"
	| "incompatible"
	| "sandbox_unavailable"
	| "handshake_rejected"
	| "enrollment_failed"
	| "adoption_failed"
	| "cancelled"
	| "unknown";

/** Local app-owned setup timeline. Attempts and refs are random opaque values, never host or alias hashes. */
export interface DevboxSetupDiagnosticEvidence {
	ref: string;
	attemptRef: string;
	sequence: number;
	source: "app";
	at: string;
	kind: "devbox.setup";
	stage: DevboxSetupDiagnosticStage;
	outcome: DevboxSetupDiagnosticOutcome;
	reason?: DevboxSetupDiagnosticReason;
}

export type DiagnosticEvidence =
	| HostSnapshotDiagnosticEvidence
	| LifecycleDiagnosticEvidence
	| RequestTimingDiagnosticEvidence
	| ToolInFlightDiagnosticEvidence
	| ToolCallDiagnosticEvidence
	| StallDiagnosticEvidence
	| NativeDiagnosticEvidence
	| DevboxSetupDiagnosticEvidence;

/** PUT /api/diagnostics/native. Full bounded replacement from the local native app. */
export interface NativeDiagnosticsBatch {
	schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
	evidence: Array<NativeDiagnosticEvidence | DevboxSetupDiagnosticEvidence>;
	dropped: number;
}

export interface SessionDiagnosticCurrent {
	state: "parked" | "starting" | "idle" | "working" | "failed";
	working: boolean;
	pauses: DiagnosticPauseReason[];
	recovery: "none" | "pending" | "stopped";
	hasError: boolean;
	errorCode?: DiagnosticErrorCode;
	queue: {
		pendingInputs: number;
		starting: boolean;
		parking: boolean;
		workspacePreparing: boolean;
		runningJobs: number;
		workingSubagents: number;
	};
}

export interface SessionDiagnosticResources {
	daemonUptimeMs?: number;
	eventLoopUtilization?: number;
	eventLoopDelayP99Ms?: number;
	inFlightRequests?: number;
	rssBytes?: number;
	heapUsedBytes?: number;
}

export interface SessionDiagnosticTruncation {
	truncated: boolean;
	returned: number;
	available: number;
	dropped: number;
	invalid: number;
	encodedBytes: number;
	maxItems: number;
	maxBytes: number;
}

/** GET /api/sessions/:id/diagnostics. Contains operational enums and numbers, never conversation history. */
export interface SessionDiagnostics {
	featureUsage?: import("./feature-usage.ts").FeatureUsageSnapshot;
	schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
	host: OperationHost;
	sessionId: string;
	release: string;
	collectedAt: string;
	freshness: DiagnosticFreshness;
	connectivity: { state: "online" | "offline" | "unknown"; observedAt?: string };
	current: SessionDiagnosticCurrent;
	resources: SessionDiagnosticResources;
	/** Durable aggregate-only usage evidence. It contains no provider, model, prompt, path or chat identity. */
	ai?: import("./index.ts").AIUsageAccounting;
	/** Optional configured comparison derived at read time. It never controls execution. */
	aiBudget?: import("./telemetry.ts").AIUsageBudgetComparison;
	sources: DiagnosticSourceStatus[];
	evidence: DiagnosticEvidence[];
	truncation: SessionDiagnosticTruncation;
}

/** Host/app diagnostics with no attached chat, transcript authority or session identifier. */
export interface AppDiagnostics {
	/** Bounded, process-local observations, available only under local diagnostic collection. */
	evidence?: DiagnosticEvidence[];
	featureUsage?: import("./feature-usage.ts").FeatureUsageSnapshot;
	schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
	scope: "app";
	host: OperationHost;
	release: string;
	collectedAt: string;
	connectivity: { state: "online" | "offline" | "unknown"; observedAt?: string };
	localDiagnostics: { enabled: boolean; coverage: "host" };
	sessions: {
		total: number;
		active: number;
		archived: number;
		working: number;
		failed: number;
		workers: number;
	};
	resources: SessionDiagnosticResources;
}

export type DiagnosticSnapshot = SessionDiagnostics | AppDiagnostics;

export type DiagnosticRepairUncertainty = "low" | "medium" | "high";

/** Closed, bounded specialist-authored suggestion. Publishing it cannot create or mutate a chat. */
export interface DiagnosticRepairProposalDraft {
	subject?: import("./diagnostic-repair.ts").DiagnosticEvidenceSubject;
	repairTitle?: string;
	evidenceRefs: string[];
	findings: string;
	uncertainty: DiagnosticRepairUncertainty;
	suggestedRepair: string;
	regressionTestGuidance: string;
}

export interface DiagnosticRepairProposal extends DiagnosticRepairProposalDraft {
	schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
	id: string;
	targetSessionId?: string;
	createdAt: string;
}

/** Explicit app action that reviews one persisted proposal for a separate repair chat. */
export interface DiagnosticsHandoffRequest {
	targetSessionId?: string;
	subject?: import("./diagnostic-repair.ts").DiagnosticEvidenceSubject;
	repairTitle?: string;
	proposalId: string;
	findings: string;
	uncertainty: DiagnosticRepairUncertainty;
	suggestedRepair: string;
	regressionTestGuidance: string;
}

/** Read-only handoff material. Creating this never starts, retries or changes either chat. */
export interface DiagnosticsHandoff {
	schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
	host: OperationHost;
	targetSessionId?: string;
	subject?: import("./diagnostic-repair.ts").DiagnosticEvidenceSubject;
	repairTitle?: string;
	/** Describes evidence only, never a destination. */
	sourceProjectId?: string;
	projectId?: string;
	evidence: DiagnosticEvidence[];
	proposalId: string;
	findings: string;
	uncertainty: DiagnosticRepairUncertainty;
	suggestedRepair: string;
	regressionTestGuidance: string;
}
