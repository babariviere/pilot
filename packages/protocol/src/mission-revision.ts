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
	/**
	 * New tasks, in order. dependsOn names existing tasks (ID or number) or the key of a new task listed earlier.
	 * In a planned mission they join the published plan, so Start and starts by rule cover them.
	 */
	newTasks?: Array<{
		key: string;
		title: string;
		body: string;
		dependsOn?: string[];
		/** The mockup the user chose in a thread chat. Confirming links it to the task, so its worker builds to match. */
		prototype?: { sessionId: string; artifactId: string; revision: number };
	}>;
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
	/** The thread whose handoff this proposal answers. Each thread keeps its own pending proposal. */
	topicId?: string;
	/** A trusted user requested a new full preview of these exact saved delta bytes. */
	repreviewOf?: { id: string; digest: string };
	confirmation?: { by: "user"; at: number; humanSource: string };
}

/** Native /api/operations, targetId=mission, bindingId=source, bindingGeneration=1. */
export interface MissionRevisionPauseIntent {
	purpose: "revision-pause";
	proposalId: string;
	digest: string;
	source: string;
}

/** Separate explicit release; confirmation never resumes work. */
export interface MissionRevisionResumeIntent {
	purpose: "revision-resume";
	pauseOperationId: string;
	source: string;
}
