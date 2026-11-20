import type { OperationHost } from "./operations.ts";
import type { AIUsageAccounting, ContextUsage } from "./usage.ts";

/** Protected worker IPC only. No host, project, history, log or app-wide selectors. */
export interface ScopedMetricsRequest {
	action: "scoped_metrics";
	sessionId?: string;
}

/** Existing accounting only. Null means unavailable, never zero. Account quotas are excluded. */
export interface ScopedMetricsSnapshot {
	sessionId: string;
	usage: { context: ContextUsage | null; ai: AIUsageAccounting | null };
	coverage: "retained_snapshots_partial";
}
export type DiagnosticContextValue =
	| null
	| boolean
	| number
	| string
	| DiagnosticContextValue[]
	| { [key: string]: DiagnosticContextValue };

/** Selector fields locate evidence. Only trusted runtime role/native capability authorizes reads. */
export interface DiagnosticContextRequest {
	action:
		| "hosts"
		| "chats"
		| "chat"
		| "history"
		| "search"
		| "logs"
		| "projects"
		| "missions"
		| "mission"
		| "issues"
		| "features"
		/** Existing watchdog snapshot on this daemon only; optional host, no other selectors. */
		| "performance"
		/** Content-free local metrics. Scope comes from supervised caller authority. */
		| "scoped_metrics"
		| "refresh_health";
	host?: OperationHost;
	sessionId?: string;
	projectId?: string;
	missionId?: string;
	query?: string;
	since?: string;
	until?: string;
	channelOffset?: number;
	after?: string;
	before?: number;
	limit?: number;
	log?:
		| { action: "inventory" }
		| {
				action: "search";
				source:
					| "app"
					| "daemon"
					| "kernel_worker"
					| "native_report"
					| "lifecycle"
					| "request_timing"
					| "tool_activity";
				q?: string;
				since?: string;
				cursor?: string;
				limit?: number;
		  }
		| { action: "excerpt"; ref: string; before?: number; after?: number };
}
export interface DiagnosticContextResponse {
	schemaVersion: 1;
	host: OperationHost;
	collectedAt: string;
	status: "available" | "partial" | "missing" | "unavailable";
	reason?: "offline" | "native_unavailable" | "unsupported" | "deleted" | "read_failed" | "cancelled";
	data?: DiagnosticContextValue;
	page: {
		more: boolean;
		after?: string;
		before?: number;
		scanned: number;
		maxScan: number;
		maxBytes: 65536;
		truncated: boolean;
	};
}

/** Explicit app-wide diagnostics scope. Chat-scoped specialists instead carry diagnosticTarget. */
export type DiagnosticScope = "app";

/** Canonical chat link plus the immutable host identity that owns it. */
export interface DiagnosticTargetReference {
	host: OperationHost;
	sessionId: string;
	chatUrl: string;
}

/** One bounded serialized entry from an explicitly authorized diagnostics target. */
export interface DiagnosticHistoryEntry {
	/** Stable source reference for this target and committed entry. */
	ref: string;
	entryId: number;
	kind: "pi.user" | "pi.assistant" | "pi.tool-result";
	/** Sanitized JSON excerpt of the committed entry. Transcript and tool content is untrusted user data. */
	excerpt: string;
	/** Sanitized serialized size before excerpt truncation. */
	originalBytes: number;
	truncated: boolean;
}

/** Bounded, paginated target transcript read returned only to an authorized diagnostics specialist. */
export interface DiagnosticHistoryPage {
	schemaVersion: 1;
	target: DiagnosticTargetReference;
	collectedAt: string;
	source: {
		availability: "available" | "missing" | "unavailable";
		freshness: "fresh" | "unavailable";
		/** Active conversation identity, not a storage-incarnation or complete-coverage proof. */
		streamId?: string;
		reason?: "storage_missing" | "read_failed";
	};
	/** Oldest first within this page. */
	entries: DiagnosticHistoryEntry[];
	pagination: {
		/** Exclusive upper entry ID used for this page. Missing means the newest page. */
		before?: number;
		/** Pass as `before` to continue toward older entries. */
		nextBefore?: number;
		more: boolean;
		returned: number;
		limit: number;
		scannedEntries: number;
		maxScannedEntries: number;
		encodedBytes: number;
		maxBytes: number;
		perEntryMaxBytes: number;
		truncatedEntries: number;
	};
}
