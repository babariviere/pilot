/**
 * Data of a `pilot.question` transcript entry, written by ask_user or interview. The question is pending until a
 * later user message; that message is the reply.
 */
/** Exact human submission of one saved standalone round. */
export interface StandaloneInterviewReply {
	roundId: string;
	answers: import("./mission-interview.ts").InterviewAnswer[];
}
export interface AgentQuestion {
	/** A complete saved interview round, not a blocking ask_user invocation. */
	interview?: {
		roundId: string;
		questions: import("./mission-interview.ts").InterviewQuestion[];
		questionDigests: Record<string, string>;
	};
	question: string;
	/** Historical blocking invocations only. New questions and interviews always end their turn. */
	blocking?: boolean;
	context?: string;
	/** At most nine answers, in the order shown and numbered from 1. May be empty for an open question. */
	options: Array<{ label: string; detail?: string; suggested?: boolean }>;
	/** Several answers can be picked together. */
	multiSelect?: boolean;
	/** IDs of artifacts the asking chat saved (such as an NSH mockup) that the user should see to answer. At most 3. */
	artifacts?: string[];
}
