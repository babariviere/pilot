import type {
	InsightsFindingDraft,
	InsightsInitialModelResolution,
	InsightsLifecycle,
	InsightsReviewSettings,
	InsightsSettingsRecord,
} from "./insights.ts";
import type { OperationHost } from "./operations.ts";
import type { ScheduledItem } from "./schedules.ts";

export interface InsightsOwnerEnablePayload {
	schemaVersion: 2;
	admissionEpoch: string;
	owner: InsightsWorkspaceOwner;
	expectedRevision: number;
	settingsRevision: number;
	model: string;
	thinking?: string;
	settings: import("./insights.ts").InsightsReviewSettings;
	/** Committed tracking transfer only, never a grant. */
	transitionId?: string;
	desiredSettingsRevision?: number;
	legacyControl?: InsightsWorkspaceTransferPayload["identity"] | null;
	disclosure: "insights-workspace-enable-v2";
}
export interface InsightsWorkspaceTransferPayload {
	schemaVersion: 2;
	admissionEpoch: string;
	owner: InsightsWorkspaceOwner;
	legacy: InsightsLegacySelector;
	identity: {
		grantId: string;
		grantRevision: number;
		enabled: boolean;
		archived: boolean;
		inputGeneration: number;
		model: string | null;
		thinking: string | null;
		bindingHash: string;
	};
	executorProof: { kind: "closed_writer_lease"; digest: string };
	manifest: { hash: string; rows: number; bytes: number; scope: string | null; counts: Record<string, number> };
	envelopesHash: string;
	references: import("./insights.ts").InsightsReplacementReference[];
	rules: ScheduledItem[];
	desired: InsightsSettingsRecord;
	effective: InsightsSettingsRecord;
	/** Old implicit revision zero becomes owned revision one; saved revisions shift by one. */
	settingsMapping: "legacy_revision_plus_one";
	settingsOrigin: "stored" | "initial_enable";
	model: string;
	thinking?: string;
	disclosure: "insights-workspace-transfer-v2";
}
export interface InsightsWorkspaceTransferReceipt {
	schemaVersion: 2;
	state: "transferred";
	workspace: InsightsWorkspaceSnapshot;
	legacy: InsightsLegacySelector;
	manifestHash: string;
	rows: number;
	activation: "not_activated";
	cancelledRules: ScheduledItem[];
}
export interface InsightsWorkspaceTransferPreview {
	schemaVersion: 2;
	state: "ready" | "blocked";
	reason: string | null;
	payload: InsightsWorkspaceTransferPayload | null;
}
export interface InsightsWorkspaceTransferStatus {
	receipt: import("./operations.ts").OperationDelivery;
	transfer:
		| { state: "absent" }
		| { state: "entered" }
		| { state: "committed"; result: InsightsWorkspaceTransferReceipt };
	/** Tracking owner only. Query execution separately; a transfer never means Enabled. */
	current: InsightsWorkspaceSnapshot | null;
}
export interface InsightsOwnerApplyChat {
	reportInputGeneration: number;
	model: string;
	thinking?: string;
	reportBindingHash: string;
}
export interface InsightsOwnerApplyPayload {
	schemaVersion: 2;
	admissionEpoch: string;
	owner: InsightsWorkspaceOwner;
	expectedRevision: number;
	grantRevision: number;
	chat: InsightsOwnerApplyChat;
	record: InsightsSettingsRecord;
	rule: ScheduledItem;
	disclosure: "insights-workspace-apply-v2";
}
export interface InsightsOwnerStatePayload {
	schemaVersion: 2;
	admissionEpoch: string;
	owner: InsightsWorkspaceOwner;
	expectedRevision: number;
	reportInputGeneration: number;
	grantRevision: number;
	rule: ScheduledItem;
	disclosure: "insights-workspace-pause-v2" | "insights-workspace-revoke-v2";
}
/** Passive compatibility projection only. Never native transition consent or v1 authority. */
export interface InsightsLegacySelector {
	schemaVersion: 2;
	reportSessionId: string;
	projectId: string;
	missionId: string;
	expectedHome: OperationHost;
	context: string;
}

/** Host-admitted execution, separate from both reservation and immutable v1 grants. */
export interface InsightsOwnerBinding {
	schemaVersion: 2;
	owner: InsightsWorkspaceOwner;
	grantId: string;
	revision: number;
	enabled: boolean;
	reportSessionId: string;
	projectId: string;
	host: OperationHost;
}

export interface InsightsOwnerExecutionStatus {
	schemaVersion: 2;
	owner: InsightsWorkspaceOwner;
	state: "pending" | "enabled" | "paused" | "revoked" | "blocked";
	grantRevision: number;
	settingsRevision: number;
	model: string;
	thinking?: string;
	thinkingSource?: "default" | "explicit";
}

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
	/** Original UTF-8 JSON request. A declared legacy snapshot uses a host projection instead. */
	request: string;
	origin?: {
		kind: "legacy_snapshot";
		transferOperationId: string;
		sourceTable: string;
		sourceKey: string;
		sourceHash: string;
	};
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
