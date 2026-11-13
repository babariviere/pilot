/** The place the user sent feedback from. Identities only; the service derives the rest. */
export type UserFeedbackOriginRef = { kind: "mission"; missionId: string } | { kind: "chat"; sessionId: string };

/** The saved origin, with the project and title the service read when it saved the feedback. */
export type UserFeedbackOrigin = UserFeedbackOriginRef & { projectId: string; title: string };

/**
 * One piece of feedback the user wrote about Pilot. It is the user's own words, separate from agent
 * Insights and findings. Saving it starts no work, approves nothing and grants no permission.
 */
export interface UserFeedback {
	id: string;
	text: string;
	/** Null: about Pilot in general, not one mission or chat. */
	origin: UserFeedbackOrigin | null;
	recordedAt: number;
	operationId: string;
}

/**
 * What a triage agent proposes for one piece of feedback. It is a proposal only: it starts, links
 * and approves nothing. The user picks what happens next.
 */
export interface UserFeedbackProposal {
	/** The agent's short reading of the feedback. */
	summary: string;
	/** IDs of other saved feedback about the same thing. */
	duplicates: string[];
	/** fix: one small scoped change; existing-mission / new-mission: larger work; none: no change. */
	next: "fix" | "existing-mission" | "new-mission" | "none";
	/** fix: the change and how to check it. Otherwise: why. */
	detail: string;
	/** existing-mission: the mission the agent suggests. Else null. */
	missionId: string | null;
	/** new-mission: a suggested goal. Else null. */
	goal: string | null;
}

/**
 * One saved step the user took on a piece of feedback, append only. A triage or fix is a chat the
 * user started; a mission link is context for that mission, not a Start. Only the user's own
 * resolved marks the feedback done; a delivered fix does not.
 */
export type UserFeedbackWork = {
	operationId: string;
	recordedAt: number;
} & (
	| { kind: "triage"; sessionId: string; projectId: string }
	| { kind: "fix"; sessionId: string; projectId: string; triageSessionId: string; proposalDigest: string }
	| { kind: "mission"; missionId: string; projectId: string }
	| { kind: "resolved" | "reopened" }
);

/** A work step as a read shows it: the saved step plus what Pilot reads about it now. */
export type UserFeedbackWorkView = UserFeedbackWork & {
	/** A triage or fix chat now. "missing" when Pilot has no such chat. */
	chat?: {
		title: string;
		state: "starting" | "working" | "question" | "done" | "failed" | "stopped" | "archived" | "missing";
	};
	/** A linked mission now, or null when it is gone. */
	mission?: { title: string; status: string; tasksDone: number; tasksTotal: number } | null;
	/** A finished triage's proposal with its digest, or why it cannot be read. */
	proposal?: { value: UserFeedbackProposal; digest: string } | { problem: string };
};

/** GET /api/feedback?before=<sequence>&limit=20. Native authenticated. Newest first, at most 20. */
export interface UserFeedbackPage {
	items: Array<UserFeedback & { sequence: number; work: UserFeedbackWorkView[] }>;
	more: boolean;
	/** The cursor for the next older page, or null when none is left. */
	before: number | null;
}

/**
 * Native generic operation kind user-feedback; targetId = the new feedback ID, chosen by the native host.
 * Native capability authentication is required. Accepted receipt.result is UserFeedback.
 * Never resend after losing the ACK: look up the exact receipt, including after a restart.
 */
export interface UserFeedbackIntent {
	purpose: "user-feedback";
	text: string;
	origin: UserFeedbackOriginRef | null;
}

/** The project chat setup a triage or fix starts with, exactly as GET /api/projects/:id/chat-profile read it. */
export interface UserFeedbackChatChoice {
	projectId: string;
	projectPath: string;
	contextDigest: string;
	model: string;
	thinking: string;
}

/**
 * Native generic operation kind feedback-work. Native capability authentication is required.
 * triage: targetId = the new read-only Ask chat. fix: targetId = the new Build chat, started from the
 * exact proposal digest the user saw. link: targetId = the mission. resolve / reopen: targetId = the
 * feedback. Accepted receipt.result is the saved UserFeedbackWork. Lost ACK: receipt lookup only.
 */
export type UserFeedbackWorkIntent = { purpose: "feedback-work"; feedbackId: string } & (
	| ({ action: "triage" } & UserFeedbackChatChoice)
	| ({ action: "fix"; triageSessionId: string; proposalDigest: string } & UserFeedbackChatChoice)
	| { action: "link"; missionId: string }
	| { action: "resolve" | "reopen" }
);
