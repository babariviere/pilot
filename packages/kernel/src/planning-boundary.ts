import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
	type Conversation,
	defineDoc,
	type Extension,
	GenerationTask,
	type Harness,
	hook,
	InboxDoc,
	LiveDoc,
	ToolTask,
} from "@earendil-works/pi-durable";
import { HeldInputsDoc } from "./held-inputs-doc.ts";
import { type PlanningInput, type PlanningRound, type PlanningWorkerBinding, planningJSON } from "./planning-worker.ts";

export const PlanningWorkerDoc = defineDoc<{
	binding: string | null;
	hold: string | null;
	receipts: Record<string, string>;
}>({
	kind: "pilot.planning-worker",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ binding: null, hold: null, receipts: {} }),
	checkpointWhen: () => false,
});

/** Block the next model turn after the completed tool result, including nested codemode. */
export function planningBoundary(extension: Extension, harness: () => Harness | undefined): Extension {
	return {
		...extension,
		hooks: [
			hook(ToolTask, {
				afterTool: async (call, result, api, context) => {
					if (!call.parent && (await harness()?.snapshot(HeldInputsDoc, api.conversationId, context))?.planning)
						return { ...result, control: { ...result.control, terminate: true } };
				},
			}),
			...(extension.hooks ?? []),
		],
	};
}

export async function holdPlanning(
	conversation: Conversation,
	binding: PlanningWorkerBinding,
	round: PlanningRound,
	context: Context,
): Promise<void> {
	await conversation.commit(async (tx) => {
		const state = await tx.doc(PlanningWorkerDoc, conversation.id);
		if (state.binding && state.binding !== planningJSON(binding)) throw new Error("Planning binding changed");
		const held = await tx.doc(HeldInputsDoc, conversation.id);
		const inbox = await tx.doc(InboxDoc, conversation.id);
		state.binding = planningJSON(binding);
		state.hold = planningJSON(round);
		held.planning = true;
		held.items.push(...inbox.items.filter((item) => item.mode !== "write"));
		inbox.items = inbox.items.filter((item) => item.mode === "write");
	}, context);
}

/** Exact planning-only admission. No input hooks, Stop release, queue drain, permission upgrade or builder. */
export async function admitPlanningInput(
	harness: Harness,
	conversation: Conversation,
	input: PlanningInput,
	guard: () => Promise<void>,
	context: Context,
): Promise<void> {
	const receipt = planningJSON({
		binding: input.binding,
		operation: input.operation,
		hold: input.hold,
		contentHash: createHash("sha256").update(input.content).digest("hex"),
	});
	await conversation.commit(async (tx) => {
		const state = await tx.doc(PlanningWorkerDoc, conversation.id);
		const existing = state.receipts[input.operation.operationId];
		if (existing) {
			if (existing !== receipt) throw new Error("Planning operation identity changed");
			return;
		}
		if (
			(state.binding && state.binding !== planningJSON(input.binding)) ||
			state.hold !== (input.hold ? planningJSON(input.hold) : null) ||
			Object.keys(state.receipts).length >= 128
		)
			throw new Error("Exact planning hold required");
		const held = await tx.doc(HeldInputsDoc, conversation.id);
		const live = await tx.doc(LiveDoc, conversation.id);
		const inbox = await tx.doc(InboxDoc, conversation.id);
		if (
			held.stopped ||
			held.paused ||
			held.questionPending ||
			held.items.length ||
			live.run ||
			live.compactions?.length ||
			inbox.items.length
		)
			throw new Error("Planning admission is held or busy");
		const entry = await tx.appendEntry(conversation.id, {
			kind: "pilot.planning-input",
			data: { operation: JSON.stringify(input.operation) },
			model: [{ role: "user", content: input.content, timestamp: Date.now() }],
		});
		const submission = await tx.createSubmission({
			conversationId: conversation.id,
			requestId: input.operation.operationId,
			type: "input",
			status: "placed",
			entry: entry.id,
		});
		live.run = {
			turns: 0,
			taskId: await tx.createTask(
				GenerationTask,
				{},
				{ ownership: { kind: "conversation" }, conversationId: conversation.id },
			),
			inputs: [submission.id],
		};
		// Last asynchronous preparation, inside the mutation transaction. Host pins allocation,
		// owner, controls, configuration and exact op. A later Stop cancels this admitted run.
		await guard();
		state.binding = planningJSON(input.binding);
		state.hold = null;
		state.receipts[input.operation.operationId] = receipt;
		held.planning = false;
	}, context);
	harness.resume();
}
