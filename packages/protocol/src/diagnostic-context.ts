import type { AIUsageAccounting, ContextUsage } from "./index.ts";
import type { OperationHost } from "./operations.ts";

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
