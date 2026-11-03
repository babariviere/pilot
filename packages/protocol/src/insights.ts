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
	  }
	| {
			action: "save_report" | "save_checkpoint";
			key: string;
			expectedRevision: number;
			operationId: string;
			record: InsightsReviewRecord;
	  };
