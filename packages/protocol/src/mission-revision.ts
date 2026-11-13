import type { MissionAssignmentWrite, MissionDecisionAudience } from "./index.ts";

/** Reviewed planning changes only. Instructions and permissions are separate, unapplied proposals. */
export interface MissionRevisionDelta {
	goal?: string;
	markdown?: string;
	tasks?: Array<{
		id: string;
		title?: string;
		body?: string;
		drop?: true;
		assignment?: MissionAssignmentWrite;
		dependsOn?: string[];
		decisionIds?: string[];
	}>;
	decisions?: Array<{
		id: string;
		reason: string;
		action: "replace" | "withdraw";
		text?: string;
		audience?: MissionDecisionAudience;
	}>;
	corrections?: Array<{ kind: "instruction" | "permission"; text: string }>;
}

export interface MissionRevisionProposal {
	version: 1;
	id: string;
	missionId: string;
	operationId: string;
	authorSessionId: string | null;
	source: string;
	digest: string;
	summary: string;
	delta: MissionRevisionDelta;
	createdAt: number;
	confirmation?: { by: "user"; at: number; humanSource: string };
}
