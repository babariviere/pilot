import type { CodingQueueView, MissionCodeCompletion, ProjectDashboard } from "./index.ts";
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

/** One capture of a reported screen: an image artifact pinned on the task's link. */
export interface ScreenCapture {
	artifactId: string;
	revision: number;
	title: string;
}

/**
 * GET /api/projects/:id/screen-pairs: each screen the current worker of a task reported, with both captures pinned,
 * so a gallery shows one Before/After card instead of two images. No Before: a new screen.
 */
export interface ScreenPairSummary {
	missionId: string;
	taskId: string;
	/** The worker chat that saved both captures. */
	sessionId: string;
	reportedAt: number;
	before?: ScreenCapture;
	after: ScreenCapture;
}

/** Scoped worker delivery facts. */
/** Omitted commit: the task changed no code, such as a decision, a mockup or research. */
export interface MissionReportDelivery extends Omit<MissionCodeCompletion, "commit"> {
	commit?: string;
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
	/** Passive task-owner activity and holds for active missions. Absent means unavailable, not no holds. */
	missionAgents?: DayMissionAgent[];
	/** Authoritative working chats, including standalone chats. Absent on older services means unknown. */
	workingNow?: DayWorkingChat[];
	/** Chats waiting for a coding slot, in line order. Absent on older services means unknown. */
	waitingNow?: DayWaitingChat[];
}

/** Passive activity, never permission to execute. A missing purpose stays explicit. */
export interface DayWorkingChat {
	sessionId: string;
	title: string;
	missionId: string | null;
	missionTitle: string | null;
	purpose: string | null;
	status: "working";
}

/** A chat whose saved input waits for a coding slot. Passive: no admission or permission to start. */
export interface DayWaitingChat {
	sessionId: string;
	title: string;
	missionId: string | null;
	missionTitle: string | null;
	queue: CodingQueueView;
}

/** Existing session state only. No admission, capacity or permission to start is implied. */
export interface DayMissionAgent {
	sessionId: string;
	missionId: string;
	title: string;
	working: boolean;
	waitingForUser: boolean;
	/** Known holds only. An empty list is not proof of execution eligibility. */
	holds: string[];
}
