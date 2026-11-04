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
