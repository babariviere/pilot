import type { OperationHost } from "./operations.ts";

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export type DiagnosticFreshness = "fresh" | "stale" | "unavailable";
export type DiagnosticSource = "lifecycle" | "request_timing" | "daemon";
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

export type DiagnosticEvidence =
	| LifecycleDiagnosticEvidence
	| RequestTimingDiagnosticEvidence
	| StallDiagnosticEvidence;

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
