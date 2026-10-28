/** Reset only the unfinished request through public APIs; a request checkpoint pins its old model. */
import type { ToolDrain } from "@babariviere/pi-extensions/tool-drain";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, type Harness, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { NativeAdapter } from "./native-adapter.ts";

const ContinuationDoc = defineDoc<{
	requestId?: string;
	phase?: "prepared" | "configured" | "submitted";
	content?: string;
	resume?: boolean;
}>({
	kind: "pilot.model-continuation",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => false,
});

export async function continueModelInPlace(
	harness: Harness,
	conversation: NonNullable<Awaited<ReturnType<Harness["conversation"]>>>,
	adapter: NativeAdapter,
	drain: ToolDrain,
	requestId: string,
): Promise<() => Promise<void>> {
	const release = adapter.holdModelRequests();
	await drain.pause(harness, context);
	await conversation.commit(async (tx) => {
		const state = await tx.doc(ContinuationDoc, conversation.id);
		if (state.requestId === requestId) return;
		const inbox = await tx.doc(InboxDoc, conversation.id);
		const live = await tx.doc(LiveDoc, conversation.id);
		const queued = inbox.items.flatMap((item) =>
			item.mode !== "write"
				? [
						typeof item.content === "string"
							? item.content
							: item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
					]
				: [],
		);
		state.requestId = requestId;
		state.phase = "prepared";
		state.resume = !!live.run || queued.length > 0;
		state.content = [
			"Continue the unfinished work on the selected model in this same chat.",
			"Completed tool effects are retained. Unexecuted tool calls were cancelled; inspect current state before retrying them.",
			...queued,
		].join("\n");
	}, context);
	let state = await harness.snapshot(ContinuationDoc, conversation.id, context);
	if (state?.phase === "prepared") {
		// This resumes scheduling, but dispatch is fenced above and tools cannot admit new effects.
		await conversation.abort(context, { background: true });
		await conversation.configure({ model: adapter.model, thinkingLevel: adapter.thinkingLevel }, context);
		await conversation.commit(async (tx) => {
			(await tx.doc(ContinuationDoc, conversation.id)).phase = "configured";
		}, context);
		state = await harness.snapshot(ContinuationDoc, conversation.id, context);
	}
	// abort() enabled the scheduler. Do not even submit the new input until the caller has bound
	// the native adapter and installed every callback/monitor; preparation hooks also need binding.
	return async () => {
		if (state?.phase === "configured") {
			if (state.resume)
				await conversation.submit(
					{
						type: "input",
						requestId,
						content: state.content ?? "Continue the unfinished work.",
						whenBusy: "followUp",
					},
					context,
				);
			await conversation.commit(async (tx) => {
				(await tx.doc(ContinuationDoc, conversation.id)).phase = "submitted";
			}, context);
		}
		drain.resume();
		release();
	};
}
