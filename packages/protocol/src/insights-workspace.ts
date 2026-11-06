import type {
	InsightsFindingDraft,
	InsightsInitialModelResolution,
	InsightsLifecycle,
	InsightsReviewSettings,
} from "./insights.ts";
import type { OperationHost } from "./operations.ts";

/** App-owned storage, never a mission, grant or executable task. */
export interface InsightsWorkspaceOwner {
	schemaVersion: 2;
	workspaceId: string;
	reportSessionId: string;
	scheduleId: string;
	projectId: string;
	expectedHome: OperationHost;
	/** Pins private profile/home/project path without disclosing those paths. */
	context: string;
}

export interface InsightsWorkspaceSnapshot {
	owner: InsightsWorkspaceOwner;
	revision: number;
	state: "reserved" | "paused" | "revoked";
	/** Reserved identities do not prove resources exist or authority is active. */
	activation: "not_activated";
}

export interface InsightsWorkspaceStatus {
	schemaVersion: 2;
	state: "absent" | "present" | "blocked" | "unavailable";
	reason: string | null;
	workspace: InsightsWorkspaceSnapshot | null;
}

/** Separate versioned payload. Never extend or reinterpret a frozen v1 command. */
export interface InsightsWorkspaceReservePayload {
	schemaVersion: 2;
	owner: InsightsWorkspaceOwner;
	model: string;
	thinking?: string;
	settings: InsightsReviewSettings;
	disclosure: "insights-workspace-reservation-v2";
}

export interface InsightsWorkspacePreflight {
	schemaVersion: 2;
	state: "ready" | "existing" | "choice_required" | "blocked" | "unavailable";
	reason: string | null;
	projectId: string | null;
	model: InsightsInitialModelResolution | null;
	payload: InsightsWorkspaceReservePayload | null;
	workspace: InsightsWorkspaceSnapshot | null;
	/** Reservation does not authorize activation or spend. */
	activationRequired: true;
}

export interface InsightsWorkspaceStatePayload {
	schemaVersion: 2;
	owner: InsightsWorkspaceOwner;
	expectedRevision: number;
	state: "paused" | "revoked";
}

export interface InsightsWorkspaceSettingsPayload {
	schemaVersion: 2;
	owner: InsightsWorkspaceOwner;
	expectedRevision: number;
	settings: InsightsReviewSettings;
}

export interface InsightsWorkspaceLifecyclePayload {
	schemaVersion: 2;
	owner: InsightsWorkspaceOwner;
	key: string;
	expectedRevision: number;
	lifecycle: InsightsLifecycle;
}

export interface InsightsWorkspaceSettings {
	revision: number;
	settings: InsightsReviewSettings;
	model: string;
	activationRequired: true;
}

export interface InsightsWorkspaceItem {
	key: string;
	kind: "finding" | "report" | "checkpoint";
	revision: number;
	lifecycle: InsightsLifecycle | null;
	/** Original UTF-8 JSON request, not reserialized nested payload bytes. */
	request: string;
	updatedAt: number;
}

export interface InsightsWorkspaceSummary {
	key: string;
	revision: number;
	lifecycle: InsightsLifecycle | null;
	title: string;
	priority: InsightsFindingDraft["priority"] | null;
	targets: InsightsFindingDraft["targets"];
	cost: NonNullable<InsightsFindingDraft["cost"]> | null;
	updatedAt: number;
}

/** A failed/unavailable list must never be rendered as a complete empty list. */
export interface InsightsWorkspacePage {
	schemaVersion: 2;
	state: "available" | "unavailable";
	reason: string | null;
	workspace: InsightsWorkspaceSnapshot | null;
	items: InsightsWorkspaceSummary[];
	nextCursor: number | null;
}

export interface InsightsWorkspaceHistoryPage {
	items: Array<InsightsWorkspaceItem & { cursor: number }>;
	nextCursor: number | null;
}
