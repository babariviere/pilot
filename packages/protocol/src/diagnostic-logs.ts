/** Fixed Pilot log catalogue that pilotd reads for diagnostics and feedback chats. */
import type { OperationHost } from "./operations.ts";

/** Sources scoped to one admitted target chat. */
export type TargetLogSourceId = "lifecycle" | "request_timing" | "tool_activity";
export type DiagnosticLogSourceId =
	| "app"
	| "next_app"
	| "day_app"
	| "daemon"
	| "kernel_worker"
	| "native_report"
	| TargetLogSourceId;

/** sessionId is a feedback-only selector; ordinary diagnostics retain their pinned target. */
export type DiagnosticLogRequest = { sessionId?: string } & (
	| { action: "inventory" }
	| {
			action: "search";
			source: DiagnosticLogSourceId;
			q?: string;
			since?: string;
			cursor?: string;
			limit?: number;
	  }
	| { action: "excerpt"; ref: string; before?: number; after?: number }
);

export interface DiagnosticLogSourceInventory {
	id: DiagnosticLogSourceId;
	scope: "host" | "target";
	availability: "available" | "unavailable" | "disabled";
	coverage: string;
	retention: "current_process" | "current_and_rotated" | "bounded_local" | "os_managed" | "none";
	availableFiles: number;
	rotatedFiles: number;
	catalogTruncated: boolean;
	reason?:
		| "not_recorded"
		| "missing"
		| "inaccessible"
		| "disabled"
		| "journal_unavailable"
		| "unsafe_source"
		| "no_target";
}

export interface DiagnosticLogRecord {
	ref: string;
	at?: string;
	text: string;
	truncated: boolean;
}

// Pilot Next is removed, but its installed apps still write logs with these omission counts.
export type NextAppLogOmissions = Partial<
	Record<"legacy" | "unbound" | "identity" | "expired" | "future" | "invalid" | "cleared", number>
>;

export interface DiagnosticLogPage {
	source: DiagnosticLogSourceId;
	status: "ok" | "unavailable" | "disabled" | "stale_cursor" | "source_changed";
	records: DiagnosticLogRecord[];
	scannedBytes: number;
	maxScanBytes: number;
	encodedBytes: number;
	maxBytes: number;
	oversizedRecords: number;
	omissions?: NextAppLogOmissions;
	truncated: boolean;
	nextCursor?: string;
	reason?: string;
}

export interface DiagnosticLogExcerpt {
	omissions?: NextAppLogOmissions;
	source: DiagnosticLogSourceId;
	status: "ok" | "unavailable" | "stale_ref" | "source_changed";
	record?: DiagnosticLogRecord;
	before: DiagnosticLogRecord[];
	after: DiagnosticLogRecord[];
	scannedBytes: number;
	maxScanBytes: number;
	truncated: boolean;
	reason?: string;
}

export interface DiagnosticLogResult {
	schemaVersion: 1;
	host: OperationHost;
	scope: "app" | "chat";
	targetSessionId?: string;
	collectedAt: string;
	untrusted: true;
	action: DiagnosticLogRequest["action"];
	sources?: DiagnosticLogSourceInventory[];
	page?: DiagnosticLogPage;
	excerpt?: DiagnosticLogExcerpt;
}
