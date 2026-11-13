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

/** GET /api/feedback?before=<sequence>&limit=20. Native authenticated. Newest first, at most 20. */
export interface UserFeedbackPage {
	items: Array<UserFeedback & { sequence: number }>;
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
