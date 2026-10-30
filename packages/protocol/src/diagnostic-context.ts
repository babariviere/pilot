import type { OperationHost } from "./operations.ts";
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
/** Ephemeral native courier read. Neither publication nor a response can mutate or wake a target. */
export interface DiagnosticReadDispatch {
	id: string;
	request: DiagnosticContextRequest;
}
