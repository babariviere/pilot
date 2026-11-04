/** Finding state is not task execution status or permission to execute. */
export type InsightsLifecycle =
	| "proposed"
	| "approved"
	| "in_progress"
	| "shipped"
	| "verified"
	| "deferred"
	| "dismissed";

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
