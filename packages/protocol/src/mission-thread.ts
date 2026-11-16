import type { OperationHost, SessionHistoryPage } from "./index.ts";

/** References to original records, not a second transcript or task/decision store. */
export type MissionThreadReference =
	| { kind: "history"; sessionId: string; entryId: number }
	| { kind: "task"; id: string }
	| { kind: "decision"; id: string };
export interface MissionThread {
	version: 1;
	id: string;
	missionId: string;
	projectId: string;
	ownerSessionId: string;
	title: string;
	revision: number;
	disposition: "open" | "later" | "discarded";
	createdBy: { kind: "user"; operationId: string; host: OperationHost };
	references: MissionThreadReference[];
	/** Saved input intents, not admission proof. Look up the exact operation receipt. */
	inputs: { operationId: string; sessionId: string }[];
}
export type MissionThreadWrite = { source: string; topicId: string } & (
	| { purpose: "thread-create"; title: string }
	| { purpose: "thread-disposition"; disposition: MissionThread["disposition"] }
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
	 * `available`: a message goes to the planning agent now. `waits`: it cannot now, but a message is saved and goes
	 * with the next planning input that can carry it (the user's submit or Continue, or a turn once it is idle).
	 */
	discussion: { available: boolean; reason: string; waits?: boolean };
	/** Thread messages saved to wait for the planning agent, in the order sent. */
	waiting?: { operationId: string; topicId: string; text: string; at: number }[];
}
export interface MissionThreadHistory {
	topic: MissionThread;
	sessionId: string;
	/** The original history, not an inferred topic-only transcript. */
	scope: "coordinator-history";
	history: SessionHistoryPage;
}
