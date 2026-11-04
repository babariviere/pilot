import type { ScheduleRecurrence } from "./schedules.ts";

/** Fixed initial suggestions, never a grant, approved spend or enabled schedule. */
export interface InsightsInitialDefaults {
	recurrence: Readonly<ScheduleRecurrence>;
	requestedModel: string;
	scope: {
		host: "local";
		projects: "admitted";
		includeArchived: true;
		sourceAccess: "read_only";
		coverage: "partial";
	};
	bounds: Readonly<InsightsReviewDispatch["bounds"]>;
	budget: {
		usd: number;
		period: "report";
		enforcement: "advisory";
		basis: "initial_assumption";
	};
	activationRequired: true;
}

/** Match configured display names only; never infer a provider/model ID or substitute a default. */
export type InsightsInitialModelResolution =
	| { state: "available"; id: string }
	| { state: "unavailable"; reason: "not_found" | "catalog_unavailable" }
	| { state: "ambiguous"; ids: string[] };

/** GET /api/insights/defaults?projectId=…; passive suggestions for explicit native setup. */
export interface InsightsSetupDefaults {
	projectId: string;
	defaults: InsightsInitialDefaults;
	model: InsightsInitialModelResolution;
}

/** Desired settings only. Saving never changes a grant, chat model or recurring rule. */
export interface InsightsReviewSettings {
	recurrence: ScheduleRecurrence;
	requestedModel: { kind: "id" | "name"; value: string };
	scope: {
		host: "local";
		projects: "admitted" | string[];
		includeArchived: boolean;
		excludeProjects: string[];
		excludeSessions: string[];
		sourceAccess: "read_only";
		coverage: "partial";
	};
	bounds: InsightsReviewDispatch["bounds"];
	budget: {
		usd: number;
		period: "report" | "month";
		enforcement: "advisory";
		basis: "initial_assumption" | "user_choice";
	};
}

/** GET /api/insights/sessions/:id/settings. Revision zero is an unpersisted suggestion. */
export interface InsightsSettingsSnapshot {
	projectId: string;
	missionId: string;
	expectedHome: import("./operations.ts").OperationHost;
	context: string;
	chat: InsightsEnableChat;
	revision: number;
	settings: InsightsReviewSettings;
	model: InsightsInitialModelResolution;
	nextAt: number;
	cost: { pricing: "unknown"; spendUsd: null };
	activationRequired: true;
}

/** Native-confirmed insights-settings operation, targetId is the exact report session. */
export interface InsightsSettingsPayload {
	projectId: string;
	missionId: string;
	expectedHome: import("./operations.ts").OperationHost;
	context: string;
	chat: InsightsEnableChat;
	expectedRevision: number;
	settings: InsightsReviewSettings;
}

export interface InsightsSettingsRecord {
	revision: number;
	settings: InsightsReviewSettings;
	/** Exact resolved available model, retained without re-resolution or substitution. */
	model: string;
}

/** Exact admitted identity, not a title, membership hint or permission to change settings. */
export interface InsightsEnableChat {
	sessionId: string;
	grantId: string;
	revision: number;
	inputGeneration: number;
	model: string;
	thinking?: string;
}

/** Frozen by native confirmation and the durable operation's immutable payload bytes. */
export interface InsightsEnablePayload {
	projectId: string;
	missionId: string;
	expectedHome: import("./operations.ts").OperationHost;
	/** Host-derived hash of local storage home, project path and backlog identity. */
	context: string;
	model: string;
	thinking?: string;
	recurrence: ScheduleRecurrence;
	scope: InsightsInitialDefaults["scope"] | InsightsReviewSettings["scope"];
	bounds: InsightsInitialDefaults["bounds"];
	budget: InsightsInitialDefaults["budget"] | InsightsReviewSettings["budget"];
	disclosure: "insights-weekly-v1";
	chat: InsightsEnableChat | null;
	schedule: { id: string; revision: number } | null;
	/** Omitted for the original fixed contract. Never add during retained-command replay. */
	settingsRevision?: number;
}

/** Passive GET /api/insights/enable/preflight?projectId=…&missionId=… */
export interface InsightsEnablePreflight {
	projectId: string;
	missionId: string;
	cost: { pricing: "unknown"; spendUsd: null };
	model: InsightsInitialModelResolution;
	state: "ready" | "existing" | "blocked";
	reason: string | null;
	/** Null means there is no confirmable operation. */
	payload: InsightsEnablePayload | null;
	/** Stable report target for the operation envelope, including fresh setup. */
	targetId: string;
	nextAt: number | null;
}

/** Pending receipt result. Entered steps are lookup-only on recovery, never effect replay. */
export interface InsightsEnableProgress {
	phase: "chat_pending" | "chat_ready" | "schedule_pending" | "enabled";
	sessionId: string;
	scheduleId: string;
	chat: InsightsEnableChat | null;
}

/** Passive POST /api/insights/enable/status with the complete immutable DurableOperation. */
export interface InsightsEnableStatus {
	receipt: import("./operations.ts").OperationDelivery;
	state: "not_found" | "partial" | "unknown" | "enabled" | "blocked";
	sessionId: string;
	scheduleId: string | null;
	nextAt: number | null;
	reason: string | null;
}

/** Finding state is not task execution status or permission to execute. */
export type InsightsLifecycle =
	| "proposed"
	| "approved"
	| "in_progress"
	| "shipped"
	| "verified"
	| "deferred"
	| "dismissed";

/** Disclosure version acknowledged by explicit native setup. */
export type InsightsDisclosure = "insights-history-v1";

export interface InsightsStatus {
	sessionId: string;
	enabled: boolean;
	revision: number;
	projectId: string;
	missionId: string;
	setupPending: boolean;
	archived: boolean;
	available: boolean;
	disclosure: InsightsDisclosure;
}

export interface InsightsFindingSummary {
	key: string;
	revision: number;
	taskId: string;
	lifecycle: InsightsLifecycle;
	title: string;
	priority: InsightsFindingDraft["priority"];
	targets: InsightsFindingDraft["targets"];
	cost: NonNullable<InsightsFindingDraft["cost"]> | null;
}

export interface InsightsFindingsPage {
	items: InsightsFindingSummary[];
	nextCursor: number | null;
}

export interface InsightsCreatePayload {
	projectId: string;
	missionId: string;
	model: string;
	thinking?: string;
	disclosure: InsightsDisclosure;
}

export interface InsightsRevokePayload {
	expectedRevision: number;
}

export interface InsightsLifecyclePayload extends InsightsRevokePayload {
	key: string;
	lifecycle: InsightsLifecycle;
}

export interface InsightsFindingDraft {
	title: string;
	priority: "low" | "medium" | "high";
	observation: string;
	uncertainty: string;
	proposedChange: string;
	expectedBenefit: string;
	/** References only. Never project access or write authority. */
	targets: Array<{ projectId: string; label: string }>;
	implementationLinks: string[];
	cost?: { baseline: string; assumptions: string; estimate: string; qualityRisks: string; laterResult: string };
}

/** Model-authored evidence/claims, not approval, delivery or verified benefit. */
export interface InsightsEvidence {
	key: string;
	sessionId: string;
	ref: string;
	observedAt: string;
	classification: "observed" | "inferred";
	summary: string;
}

/** A claimed review position. The writer does not certify stream continuity or coverage. */
export interface InsightsCheckpoint {
	sessionId: string;
	streamId: string | null;
	before: number | null;
	after: string | null;
	throughEntry: number | null;
	coverage: "partial" | "unavailable" | "sampled";
	gaps: string[];
}

export interface InsightsReviewRecord {
	status: "partial" | "interrupted" | "completed";
	windowStart: string;
	windowEnd: string;
	markdown: string;
	checkpoints: InsightsCheckpoint[];
	findingKeys: string[];
	gaps: string[];
}

export type InsightsBacklogRequest =
	| { action: "review_context"; cursor?: number }
	| { action: "list"; kind: "finding" | "report" | "checkpoint"; cursor?: number; limit?: number }
	| { action: "get"; kind: "finding" | "report" | "checkpoint"; key: string }
	| { action: "history"; kind: "finding" | "report" | "checkpoint"; key: string; cursor?: number; limit?: number }
	| { action: "evidence"; key: string; cursor?: number; limit?: number }
	| { action: "receipt"; operationId: string }
	| {
			action: "propose" | "amend";
			key: string;
			expectedRevision: number;
			operationId: string;
			draft: InsightsFindingDraft;
			evidence: InsightsEvidence[];
			/** Stable target + failure-mechanism label. Not an authorization or coverage claim. */
			patternKey?: string;
	  }
	| {
			action: "save_report" | "save_checkpoint";
			key: string;
			expectedRevision: number;
			operationId: string;
			record: InsightsReviewRecord;
	  };

/** Trusted host dispatch, never a model-selected grant or scheduler completion receipt. */
export interface InsightsReviewDispatch {
	runId: string;
	windowStart: string;
	windowEnd: string;
	bounds: { inventoryPages: number; historyPages: number; entriesPerPage: number };
	settingsRevision?: number;
}

export interface InsightsReviewRun {
	runId: string;
	state: "preparing" | "ready" | "sent" | "partial" | "cancelled" | "interrupted" | "unknown";
	windowStart: string;
	windowEnd: string;
	reportKey: string | null;
	/** Persistence and placement only. Never proof of comprehensive review or benefit. */
	detail: string;
}
