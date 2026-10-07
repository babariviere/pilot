/** Explicit human-attention signals and restart-stable settled-run outcomes. */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineTool,
	type Conversation,
	type Cursor,
	type Extension,
	type Harness,
	LiveDoc,
	type Storage,
	type SubmissionId,
	type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { SessionCompletion } from "@pilot/protocol";

type AttentionState = {
	signal?: { input: number; outcome: "done" | "needs_input"; reason: string };
	completion?: { [K in keyof SessionCompletion]: SessionCompletion[K] } & { input: number; entry: number };
};

export const AttentionDoc = defineDoc<AttentionState>({
	kind: "pilot.attention",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

export const reportStatus = defineTool({
	name: "pilot_report_status",
	description:
		"Report the task outcome before your final response, not merely that your reply is finished. Use done only when the requested work is complete. Use needs_input when an answer, decision, approval or missing information blocks further work, including an ongoing design discussion awaiting a decision or permission to implement. Do not mark an unfinished task done just because you proposed a plan or answered one part of it. A fully answered standalone question can be done; optional offers after completed work are not blockers. This records a status, not a suspended tool; ask the actual question in your final response and wait for the user's next message.",
	parameters: Type.Object({
		status: Type.Union([Type.Literal("done"), Type.Literal("needs_input")]),
		reason: Type.String({ minLength: 1, maxLength: 1000 }),
	}),
	// This tool only replaces durable JSON state. Replaying the same intent is harmless.
	replay: "safe",
	executionMode: "sequential",
	execute: async (args, api, context) => {
		if (!args.reason.trim()) throw new Error("A non-blank reason is required");
		await api.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, api.conversationId);
			const inputs = live.run?.inputs;
			if (!inputs?.length) throw new Error("No active run to report");
			// Inputs are in placement order, not admission-ID order. A queued steer
			// can be admitted before a follow-up but placed later in that follow-up's run.
			const input = inputs[inputs.length - 1]!;
			const attention = await tx.doc(AttentionDoc, api.conversationId);
			attention.signal = { input, outcome: args.status, reason: args.reason.trim() };
		}, context);
		return { content: [{ type: "text", text: "Status recorded. Now give your final response to the user." }] };
	},
});

/** Added after replayUnsafe(), so only native tools are forced replay-unsafe. */
export function withAttention(extension: Extension): Extension {
	return { ...extension, tools: [...(extension.tools ?? []), reportStatus] };
}

export function classifyCompletion(
	record: SubmissionRecord,
	signal?: AttentionState["signal"],
): Omit<SessionCompletion, "outcomeAt"> {
	if (record.status === "unanswered") {
		if (record.reason === "aborted" || record.reason === "reset") return { outcome: "stopped" };
		return {
			outcome: "failed",
			outcomeReason: typeof record.detail === "string" ? record.detail : record.reason,
		};
	}
	if (record.status !== "done" || record.type !== "input") throw new Error("Input has not settled");
	return signal?.input === record.id ? { outcome: signal.outcome, outcomeReason: signal.reason } : { outcome: "done" };
}

/** Reconcile after run_end or an idle snapshot, including a crash before outcome publication. */
export async function reconcileCompletion(
	storage: Storage,
	harness: Harness,
	conversation: Conversation,
	context: Context,
	inputs?: readonly SubmissionId[],
): Promise<SessionCompletion | undefined> {
	let latest: SubmissionRecord | undefined;
	const consider = (record: SubmissionRecord | undefined) => {
		// Withdrawn queued inputs never ran, and must not overwrite a real outcome.
		if (
			record?.type !== "input" ||
			record.entry === undefined ||
			(record.status !== "done" && record.status !== "unanswered")
		)
			return;
		if (!latest || record.entry > (latest.entry ?? 0)) latest = record;
	};
	if (inputs) {
		for (const input of inputs) consider(await storage.submission(input, context));
	} else {
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanSubmissions({ conversationId: conversation.id }, 100, cursor, context);
			for (const record of page.items) consider(record);
			cursor = page.next;
		} while (cursor !== undefined);
	}
	const attention = await harness.snapshot(AttentionDoc, conversation.id, context);
	if (!latest || (attention?.completion && attention.completion.entry >= latest.entry!)) return attention?.completion;
	const record = latest;
	return conversation.commit(async (tx) => {
		const state = await tx.doc(AttentionDoc, conversation.id);
		if (state.completion && state.completion.entry >= record.entry!) return { ...state.completion };
		const completion = {
			...classifyCompletion(record, state.signal),
			outcomeAt: Math.max(Date.now(), (state.completion?.outcomeAt ?? 0) + 1),
			input: record.id,
			entry: record.entry!,
		};
		state.completion = completion;
		return completion;
	}, context);
}
