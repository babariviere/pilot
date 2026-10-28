import { defineDoc, type InboxItem } from "@earendil-works/pi-durable";

export type HeldInput = Extract<InboxItem, { content: unknown }>;
export type SystemMessageStateEvent = {
	id: string;
	requestId: string;
	state: "held" | "discarded";
	preview: string;
};

/** Shared by admission and the app's queue editor, without a dependency cycle. */
export const HeldInputsDoc = defineDoc<{
	stopped: boolean;
	/** Optional for v1 stores. Only explicit resume/redirect releases a pause. */
	paused?: boolean;
	/** Daemon-owned monotonic queue-control revision. Lost acknowledgements cannot undo newer controls. */
	controlRevision?: number;
	items: HeldInput[];
	serial: number;
	events: SystemMessageStateEvent[];
}>({
	kind: "pilot.held-inputs",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ stopped: false, items: [], serial: 0, events: [] }),
	checkpointWhen: () => false,
});
