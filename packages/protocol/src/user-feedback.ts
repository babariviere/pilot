import type { DurableOperation } from "./operations.ts";
import type { StagedAttachmentRef } from "./transfers.ts";

/** The place the user sent feedback from. Identities only; the service derives the rest. */
export type UserFeedbackOriginRef = { kind: "mission"; missionId: string } | { kind: "chat"; sessionId: string };

/** The saved origin, with the project and title the service read when it saved the feedback. */
export type UserFeedbackOrigin = UserFeedbackOriginRef & { projectId: string; title: string };

/** Exact native follow-up retained before Send. Saving it never dispatches it. */
export interface UserFeedbackInvestigation {
	operation: DurableOperation;
}

/** User-written feedback. An optional native-pinned investigation starts no fix or other work. */
export interface UserFeedback {
	investigation?: UserFeedbackInvestigation;
	/** Immutable original save input hash. Missing on legacy feedback. */
	savePayloadHash?: string;
	/** Immutable images saved with this feedback. Omitted on older records. */
	attachments?: StagedAttachmentRef[];
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
	/**
	 * fix: one small scoped change; prototype: the look or behavior is unclear, so mock it up first;
	 * existing-mission / new-mission: larger work; none: no change.
	 */
	next: "fix" | "prototype" | "existing-mission" | "new-mission" | "none";
	/** fix: the change and how to check it. prototype: what to explore. Otherwise: why. */
	detail: string;
	/** existing-mission: the mission the agent suggests. Else null. */
	missionId: string | null;
	/** new-mission: a suggested goal. Else null. */
	goal: string | null;
	/** prototype only: two or three directions to mock up. */
	directions?: string[];
	/** A fix from a prototype chat only: the mockup the user chose, at the revision Pilot read. */
	mockup?: UserFeedbackArtifact;
}

/** One saved artifact of a feedback chat, such as a prototype's mockup, at an exact revision. */
export interface UserFeedbackArtifact {
	/** The chat that saved it. */
	sessionId: string;
	artifactId: string;
	title: string;
	kind: string;
	revision: number;
}

/**
 * One saved step the user took on a piece of feedback, append only. A triage, prototype or fix is a
 * chat the user started; a mission link is context for that mission, not a Start. Only the user's own
 * resolved marks the feedback done; a delivered fix does not.
 */
export type UserFeedbackWork = {
	operationId: string;
	recordedAt: number;
} & (
	| { kind: "triage"; sessionId: string; projectId: string }
	/** A read-only chat that mocks up the triage's prototype proposal and asks the user to choose. */
	| { kind: "prototype"; sessionId: string; projectId: string; triageSessionId: string; proposalDigest: string }
	/** triageSessionId: the triage or prototype chat whose exact proposal the fix starts from. */
	| { kind: "fix"; sessionId: string; projectId: string; triageSessionId: string; proposalDigest: string }
	| { kind: "mission"; missionId: string; projectId: string }
	| { kind: "resolved" | "reopened" }
	/** The user's answer to the question `questionId` of a triage, prototype or fix chat, as sent to that chat. */
	| { kind: "answer"; sessionId: string; questionId: number; text: string }
	/** An explicit correction of the exact finished recommendation, sent only to its triage. */
	| { kind: "correction"; sessionId: string; proposalDigest: string; text: string }
);

/** The receipt of a remove step. The feedback and its saved steps are gone; its chats and missions stay. */
export interface UserFeedbackRemoved {
	operationId: string;
	recordedAt: number;
	kind: "removed";
}

/** The question a feedback chat waits on, as its chat saved it. Answering it starts and approves nothing. */
export interface UserFeedbackQuestion {
	/** The question's history entry. An answer names it; a newer question refuses an older answer. */
	id: number;
	question: string;
	context?: string;
	/** At most nine suggested answers, in order. Empty for an open question. */
	options: Array<{ label: string; detail?: string; suggested?: boolean }>;
	multiSelect?: boolean;
	/** Artifacts the chat attached to look at before answering, such as mockups. IDs it does not have are left out. */
	artifacts?: UserFeedbackArtifact[];
}

/** A work step as a read shows it: the saved step plus what Pilot reads about it now. */
export type UserFeedbackWorkView = UserFeedbackWork & {
	/** A triage, prototype or fix chat now. "missing" when Pilot has no such chat. */
	chat?: {
		title: string;
		state: "starting" | "working" | "question" | "done" | "failed" | "stopped" | "archived" | "missing";
		/** Present while the chat waits for a coding slot. */
		queue?: import("./index.ts").CodingQueueView;
	};
	/** A chat waiting on the user: its pending question. */
	question?: UserFeedbackQuestion;
	/** A linked mission now, or null when it is gone. */
	mission?: { title: string; status: string; tasksDone: number; tasksTotal: number } | null;
	/**
	 * A finished triage or prototype: its proposal (a prototype's is the fix the user chose), or unusable
	 * explanation and its full-text hash. Raw over 8 KiB stays in chat history.
	 */
	proposal?: { value: UserFeedbackProposal; digest: string } | { problem: string; raw?: string; digest: string };
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
	investigation?: UserFeedbackInvestigation;
	attachments?: StagedAttachmentRef[];
	purpose: "user-feedback";
	text: string;
	origin: UserFeedbackOriginRef | null;
}

/** The project chat setup a triage or fix starts with, exactly as GET /api/projects/:id/chat-profile read it. */
export interface UserFeedbackChatChoice {
	allowanceMicros?: number | null;
	fundingRequired?: true;
	projectId: string;
	projectPath: string;
	contextDigest: string;
	model: string;
	thinking: string;
}

/**
 * Native generic operation kind feedback-work. Native capability authentication is required.
 * triage: targetId = the new read-only Ask chat. prototype: targetId = the new read-only Ask chat that
 * mocks up the triage's exact prototype proposal. fix: targetId = the new Build chat, started from the
 * exact triage or prototype proposal digest the user saw. link: targetId = the mission. resolve / reopen: targetId = the
 * feedback. remove: targetId = the feedback; deletes it and its steps, never its chats or missions.
 * answer: targetId = the item's latest triage, prototype or fix chat, sent as the reply to its pending question
 * `questionId`; it starts no fix and approves no proposal. correct: targetId = the exact finished triage,
 * proposalDigest = its exact proposal or unusable explanation's digest. Sends a follow-up in that Ask chat only.
 * A triage with adoptSessionId names an existing screen agent chat (role "screen") of the same project instead:
 * targetId = that chat. Pilot saves the step and sends the triage instruction to that chat; it creates no chat.
 * Accepted receipt.result is the saved UserFeedbackWork. Lost ACK: receipt lookup only; for a reply it reads whether the chat
 * accepted that exact input, and never sends it again.
 */
export type UserFeedbackWorkIntent = { purpose: "feedback-work"; feedbackId: string } & (
	| ({ action: "triage"; adoptSessionId?: string } & UserFeedbackChatChoice)
	| ({ action: "prototype" | "fix"; triageSessionId: string; proposalDigest: string } & UserFeedbackChatChoice)
	| { action: "link"; missionId: string }
	| { action: "resolve" | "reopen" | "remove" }
	| { action: "answer"; questionId: number; message: string }
	| { action: "correct"; proposalDigest: string; message: string }
);
