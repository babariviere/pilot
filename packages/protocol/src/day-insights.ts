import type { InsightsWorkspaceOwner } from "./insights-workspace.ts";

/** Separate from immutable advisory v1/v2 settings. USD amounts are catalog estimates. */
export interface DayInsightsSettings {
	model: string;
	thinking?: string;
	source: { projects: string[]; excludeProjects: string[]; excludeSessions: string[] };
	weekly: { day: number; time: string; timezone: string } | null;
	allowance: { perReportMicros: number; monthlyMicros: number; basis: "catalog_estimate" };
}
export type DayInsightsAction = "save" | "apply" | "run" | "pause" | "resume";
export interface DayInsightsReview {
	action: DayInsightsAction;
	expectedRevision: number;
	/** Explicit execution project. Pinned after first Save/Apply, never the selected UI tab. */
	projectId: string;
	settings: DayInsightsSettings | null;
}
export interface DayInsightsPayload {
	schemaVersion: 1;
	admissionEpoch: string;
	owner: InsightsWorkspaceOwner;
	action: DayInsightsAction;
	expectedRevision: number;
	settings: DayInsightsSettings | null;
	disclosure: "day-insights-v1";
}
export interface DayInsightsPreflight {
	schemaVersion: 1;
	state: "ready" | "blocked" | "unavailable";
	reason: string | null;
	payload: DayInsightsPayload | null;
}
export interface DayInsightsStatus {
	schemaVersion: 1;
	revision: number;
	owner: InsightsWorkspaceOwner | null;
	draft: DayInsightsSettings | null;
	effective: DayInsightsSettings | null;
	paused: boolean;
	executionSupported: boolean;
	uncertainOperationId: string | null;
	/** Null means unavailable, not idle or zero. */
	running: boolean | null;
	nextAt: number | null;
	holdReason: string | null;
	remaining: { perReportMicros: number | null; monthlyMicros: number | null; uncertainMicros: number | null };
}

/** One preserved bounded legacy projection per page. Cursor is opaque. */
export interface DayInsightsLegacyPage {
	schemaVersion: 1;
	state: "available" | "unavailable";
	reason: string | null;
	items: Array<{ kind: "report" | "finding"; projection: unknown }>;
	nextCursor: string | null;
}
