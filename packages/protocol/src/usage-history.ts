import type { AIUsageCost, AIUsageTokens } from "./index.ts";

/** Local-only accounting. Never serialize these identities through telemetry/diagnostics. */
export interface UsageObservation {
	schemaVersion: 1;
	generation: string;
	sourceId: string;
	operationId: string;
	revision: number;
	kind: "request" | "checkpoint";
	scope: "direct" | "child";
	observedAt: number;
	completedAt?: number;
	coverage: "committed" | "legacy" | "partial";
	purpose:
		| "agent"
		| "control"
		| "follow_up"
		| "title"
		| "triage"
		| "classification"
		| "memory"
		| "compaction"
		| "other"
		| "unknown";
	attribution?: {
		projectId?: string;
		chatId?: string;
		runId?: string;
		mission?: { homeId: string; lineageId: string; missionId: string };
	};
	physicalModel?: { provider: string; model: string };
	virtualModel?: { provider: string; model: string };
	tokens: AIUsageTokens;
	cost: AIUsageCost;
	requests?: number;
	providerAttempts?: number;
	retries?: number;
	durationMs?: number;
	outcome?: "success" | "failure" | "cancelled" | "unknown";
}

export interface UsageHistoryStatus {
	schemaVersion: 1;
	generation: string;
	coverageStartedAt: number;
	captureFloor: number;
	retentionFloor: number;
	retainedRows: number;
	rejected: number;
	conflicts: number;
	expired: number;
	/** Process-local ingress overflow, separate from durable rejection counts. */
	queueOverflows: number;
	coverage: "partial";
}

export interface UsageHistoryQuery {
	kind: "request" | "checkpoint";
	from: number;
	to: number;
	limit?: number;
	/** Opaque keyset token, invalid after erasure. */
	after?: string;
}

export interface UsageHistoryPage {
	rows: UsageObservation[];
	next?: string;
	status: UsageHistoryStatus;
}

export type UsageHistoryWriteResult = "stored" | "duplicate" | "stale" | "conflict" | "rejected";
