import type { OperationHost } from "./operations.ts";

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export type DiagnosticFreshness = "fresh" | "stale" | "unavailable";
export type DiagnosticSource = "lifecycle" | "request_timing" | "tool" | "daemon" | "os";
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

export type DiagnosticEvidence =
	| LifecycleDiagnosticEvidence
	| RequestTimingDiagnosticEvidence
	| ToolInFlightDiagnosticEvidence
	| ToolCallDiagnosticEvidence
	| StallDiagnosticEvidence
	| NativeDiagnosticEvidence;

/** PUT /api/diagnostics/native. Full bounded replacement from the local native app. */
export interface NativeDiagnosticsBatch {
	schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
	evidence: NativeDiagnosticEvidence[];
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
	schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
	host: OperationHost;
	sessionId: string;
	release: string;
	collectedAt: string;
	freshness: DiagnosticFreshness;
	connectivity: { state: "online" | "offline" | "unknown"; observedAt?: string };
	current: SessionDiagnosticCurrent;
	resources: SessionDiagnosticResources;
	sources: DiagnosticSourceStatus[];
	evidence: DiagnosticEvidence[];
	truncation: SessionDiagnosticTruncation;
}

/** Explicit app action that selects a bounded specialist finding for a separate repair chat. */
export interface DiagnosticsHandoffRequest {
	targetSessionId: string;
	evidenceRefs: string[];
	likelyCause: string;
	regressionTestGuidance: string;
}

/** Read-only handoff material. Creating this never starts, retries or changes either chat. */
export interface DiagnosticsHandoff {
	schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
	host: OperationHost;
	targetSessionId: string;
	projectId?: string;
	evidence: DiagnosticEvidence[];
	likelyCause: string;
	regressionTestGuidance: string;
}
