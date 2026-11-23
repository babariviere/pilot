import type { ArtifactSummary } from "../artifacts/artifacts.ts";
import type {
	AssistanceRequest,
	AssistanceScope,
	HumanActionCommand,
	HumanActionRecord,
} from "./decision-assistance.ts";
import type { OperationHost } from "../operations/operations.ts";
import type { AgentQuestion, StandaloneInterviewReply } from "../chats/questions.ts";
import type { SessionSummary } from "../chats/session.ts";

/** Sent only over the authenticated native boundary. An actor field cannot authenticate a caller. */
export interface NativeAttentionEnvelope {
	version: 1;
	home: OperationHost;
	projectId: string;
}
export interface NativeAttentionQuestion {
	scope: AssistanceScope;
	question: AgentQuestion;
	session: Pick<SessionSummary, "id" | "title" | "missionId" | "inputGeneration">;
	/**
	 * The question's artifacts at their latest revision: the chat's own, or another chat's artifact linked to the
	 * chat's mission (then `sessionId` names that chat). Unknown IDs are left out.
	 */
	artifacts?: Array<Pick<ArtifactSummary, "id" | "title" | "kind" | "revision"> & { sessionId?: string }>;
}
export interface NativeAttentionRead {
	version: 1;
	projectId: string;
	questions: NativeAttentionQuestion[];
	actions: Array<{ record: HumanActionRecord; authorityDigest: string }>;
	capabilities: { help: "unavailable" | 1; clarification?: 1; interviewDrafts?: 1; continuation: "unavailable" };
}
export interface StandaloneInterviewDraft extends StandaloneInterviewReply {
	/** Independent of the question revision. A save never submits answers. */
	revision: number;
}
export type NativeAttentionRequest = NativeAttentionEnvelope &
	(
		| { kind: "read" }
		| { kind: "interview-draft"; scope: AssistanceScope; roundId: string }
		| {
				kind: "interview-draft-save";
				scope: AssistanceScope;
				draft: StandaloneInterviewReply;
				/** Null creates the draft only if there is no saved revision yet. */
				expectedRevision: number | null;
		  }
		| { kind: "action"; authorityDigest: string; command: HumanActionCommand }
		| { kind: "help"; request: AssistanceRequest }
		| { kind: "resource"; expected: Pick<HumanActionRecord, "id" | "revision" | "digest">; authorityDigest: string }
	);
