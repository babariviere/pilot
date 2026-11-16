import type { OperationHost, SessionHistoryPage } from "./index.ts";

/** References to original records, not a second transcript or task/decision store. */
export type MissionThreadReference =
	| { kind: "history"; sessionId: string; entryId: number }
	| { kind: "task"; id: string }
	| { kind: "decision"; id: string };
/** `resolved`: a confirmed revision answered the thread's handoff. Pilot sets it; the user can reopen. */
export type MissionThreadDisposition = "open" | "later" | "discarded" | "resolved";
/** What a thread chat sends to the planner once the user agreed in the thread. It grants nothing. */
export interface MissionThreadHandoff {
	id: string;
	/** The thread chat that wrote it. */
	sessionId: string;
	summary: string;
	tasks: Array<{
		key: string;
		title: string;
		outcome: string;
		acceptance: string[];
		/** Existing task IDs or numbers, or keys of tasks listed earlier in this handoff. */
		dependsOn?: string[];
		/** A mockup the thread chat published and the user chose. */
		prototype?: { artifactId: string; revision: number };
	}>;
	at: number;
	/** When Pilot saved it to wait for the planning agent. Set once, so it is sent once. */
	queuedAt?: number;
}
export interface MissionThread {
	version: 1;
	id: string;
	missionId: string;
	projectId: string;
	ownerSessionId: string;
	title: string;
	revision: number;
	disposition: MissionThreadDisposition;
	createdBy: { kind: "user"; operationId: string; host: OperationHost };
	references: MissionThreadReference[];
	/** Saved input intents, not admission proof. Look up the exact operation receipt. */
	inputs: { operationId: string; sessionId: string }[];
	/**
	 * The thread chat: a read-only chat that discusses this thread with the user. The operation that started it, and
	 * its session once started. A closed (resolved or discarded) thread's chat is archived; reopening starts a new one.
	 */
	chat?: { operationId: string; sessionId?: string };
	/** The latest handoff to the planner. */
	handoff?: MissionThreadHandoff;
	/** The confirmed revision that resolved the thread, and the tasks it added. */
	resolvedBy?: { proposalId: string; taskIds: string[] };
	/** The thread's messages with the planner before it had a thread chat, kept once when it moved. */
	earlier?: Array<{ role: "you" | "coordinator"; text: string }>;
}
export type MissionThreadWrite = { source: string; topicId: string } & (
	| { purpose: "thread-create"; title: string }
	| { purpose: "thread-disposition"; disposition: "open" | "later" | "discarded" }
	| { purpose: "thread-reference"; reference: MissionThreadReference }
	| { purpose: "thread-send"; text: string }
);
export interface MissionThreadsView {
	version: 1;
	missionId: string;
	projectId: string;
	/** Use as operation.bindingId and payload.source, bindingGeneration=1. */
	source: string;
	topics: MissionThread[];
	/**
	 * `available`: a message goes to the thread's chat now. `waits` stays for older clients and is false: a thread
	 * chat takes messages while the planning agent works.
	 */
	discussion: { available: boolean; reason: string; waits?: boolean };
	/** Older thread messages still waiting for the planning agent, in the order sent. Empty once moved to thread chats. */
	waiting?: { operationId: string; topicId: string; text: string; at: number }[];
}
export interface MissionThreadHistory {
	topic: MissionThread;
	sessionId: string;
	/** The thread chat's history once it has one; before that, the original coordinator history. */
	scope: "coordinator-history" | "thread-chat";
	history: SessionHistoryPage;
}
