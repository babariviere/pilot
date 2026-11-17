import type { MissionCodeCompletion, ProjectDashboard } from "./index.ts";
import type { MissionControl } from "./mission-controls.ts";

/** One screen captured from the real app: image artifact IDs, Before at the landed commit's parent. No Before: new. */
export interface MissionScreenPair {
	before?: string;
	after: string;
}

/**
 * Captures for a change users can see. Each ID names an image artifact the worker attached to the task with a pinned
 * revision. `none` says why there are no captures.
 */
export type MissionDeliveryScreens = { pairs: MissionScreenPair[] } | { none: string };

/** Scoped worker delivery facts. */
export interface MissionReportDelivery extends MissionCodeCompletion {
	screens?: MissionDeliveryScreens;
}

/** Source token is issued by the host, never inferred from text or activity. */
export interface MissionReportWrite {
	version: 1;
	reportId: string;
	taskId: string;
	source: string;
	expectedPreviousId: string | null;
	movement: "moving" | "not_moving" | "unknown";
	summary: string;
	nextStep: string;
	evidence: string[];
	/** Scoped worker delivery claim, not canonical completion or user acceptance. */
	delivery?: MissionReportDelivery;
}

export interface MissionReport {
	version: 1;
	missionId: string;
	projectId: string;
	sessionId: string;
	coordinatorSessionId: string | null;
	reportedAt: number;
	/** Expiry is a display limit, not proof of progress before this time. */
	validUntil: number;
	write: MissionReportWrite;
}

export interface MissionReportView {
	report: MissionReport;
	currentness: "current" | "stale" | "unavailable";
	/** Agent-reported only. Never delivery acceptance or measured progress. */
	provenance: "agent_report";
}

/** Complete existing projections, not the dashboard's first five rows. */
export interface DayOverview {
	version: 1;
	projectId: string;
	observedAt: number;
	complete: true;
	dashboard: ProjectDashboard;
	reports: MissionReportView[];
	controls: MissionControl[];
}
