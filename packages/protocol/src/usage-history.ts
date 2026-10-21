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
		/** Opaque durable conversation identity, not the current chat's model selection. */
		attemptId?: string;
		runId?: string;
		mission?: { homeId: string; lineageId: string; missionId: string };
	};
	physicalModel?: { provider: string; model: string };
	virtualModel?: { provider: string; model: string };
	/** Present only when the already-selected router exposes an immutable revision. */
	virtualRevision?: string;
	parent?: { sourceId: string; operationId: string };
	/** Unknown response usage is absent, never a synthetic zero. */
	tokens?: AIUsageTokens;
	cost?: AIUsageCost;
	activity?: "compaction";
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
	filters?: UsageQueryFilters;
}

export interface UsageHistoryPage {
	rows: UsageObservation[];
	next?: string;
	status: UsageHistoryStatus;
}

export type UsageHistoryWriteResult = "stored" | "duplicate" | "stale" | "conflict" | "rejected";

/** Exact observed identifiers. Mission home/lineage is never the execution host or an alias. */
export interface UsageQueryFilters {
	projectId?: string;
	chatId?: string;
	mission?: { homeId: string; lineageId: string; missionId: string };
	purpose?: UsageObservation["purpose"];
	physicalModel?: { provider: string; model: string };
	virtualModel?: { provider: string; model: string };
	virtualRevision?: string;
	/** Drill into explicit unknown/unattributed groups without treating absence as a wildcard. */
	missing?: Array<"project" | "mission" | "chat" | "physicalModel" | "virtualPolicy" | "virtualRevision">;
}

export type UsageDimension = "project" | "mission" | "chat" | "purpose" | "physicalModel" | "virtualPolicy" | "scope";
export interface UsageAnalyticsQuery {
	version: 1;
	from: number;
	to: number;
	filters?: UsageQueryFilters;
	view: "summary" | "breakdown" | "buckets";
	dimension?: UsageDimension;
	bucketMs?: 3600000 | 86400000;
	limit?: number;
	after?: string;
}
/** value is a known subtotal, not a claim that missing evidence was zero. Overflow omits value. */
export interface UsageMetric {
	value?: number;
	known: number;
	unknown: number;
	/** Present numeric subtotals explicitly reported as incomplete. Subset of known. */
	partial: number;
	overflow: boolean;
}
export interface UsageAggregate {
	records: number;
	committed: number;
	partial: number;
	legacy: number;
	unpriced: number;
	partialPriced: number;
	pricingVersions: number;
	/** Enables honest same/mixed-version estimates across hosts without an unbounded revision list. */
	pricingRevision?: string;
	metrics: Record<
		| "input"
		| "output"
		| "cacheRead"
		| "cacheWrite"
		| "reasoning"
		| "estimatedUsdMicros"
		| "billedUsdMicros"
		| "requests"
		| "providerAttempts"
		| "retries"
		| "durationMs",
		UsageMetric
	>;
}
export interface UsageAnalyticsResult {
	version: 1;
	queriedAt: number;
	status: UsageHistoryStatus;
	/** Only dated requests. Never add reconciliation checkpoints to this. */
	total: UsageAggregate;
	/** Retained checkpoints, independent of chart dates. Metrics carry coverage counts ONLY, never sums. */
	reconciliation: UsageAggregate;
	/** Sparse UTC buckets or exact JSON tuple keys, including null for unknown attribution. */
	groups: Array<{ key: string; aggregate: UsageAggregate }>;
	next?: string;
	truncated: boolean;
	coverage: "partial";
}

/** Read-only native projection; no daemon relays, connection attempts or accounting replication. */
export interface UsageHostProjection {
	host: { hostId: string; daemonId: string; lineageId: string };
	state: "fresh" | "disconnected" | "unsupported" | "unavailable" | "alias" | "limited";
	result?: UsageAnalyticsResult;
}

export interface UsageConnectedProjection {
	hosts: UsageHostProjection[];
	omittedHosts: number;
	queriedAt: number;
	coverage: "partial";
}
