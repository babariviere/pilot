/** Pilot's idle manual compaction barrier. The Harness still owns summarization, generation and recovery. */
import type { Context } from "@earendil-works/chord";
import {
	CompactionTask,
	type Conversation,
	type ConversationId,
	defineExtension,
	defineTask,
	type Harness,
	InboxDoc,
	LiveDoc,
	type UserInput,
} from "@earendil-works/pi-durable";
import type { DeliveryMode } from "@pilot/protocol";

export function createManualCompaction(
	drain: (id: ConversationId, requestId: string, context: Context) => Promise<boolean>,
) {
	const BarrierTask = defineTask<Record<string, never>, { phase: "wait" } | { phase: "drain" }, Record<string, never>>(
		{
			name: "pilot.manual-compaction",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async (_task, runtime, context) => {
					await runtime.commit(async (tx) => {
						const live = await tx.doc(LiveDoc, runtime.conversationId);
						if (live.compactions?.length)
							return {
								status: "waiting",
								checkpoint: { phase: "wait" },
								on: live.compactions.map(({ taskId }) => taskId),
								policy: "allSettled",
							};
						const inbox = await tx.doc(InboxDoc, runtime.conversationId);
						return !live.run && inbox.items.length
							? { status: "running", checkpoint: { phase: "drain" } }
							: { status: "terminal", outcome: { status: "completed", result: {} } };
					}, context);
				},
				drain: async (task, runtime, context) => {
					// SDK admission applies its final boundary, including writes, stale heads and queue modes.
					// A passive model-free write makes this recoverable after a crash, without a second model loop.
					const drained = await drain(runtime.conversationId, `manual-compaction-boundary:${task.id}`, context);
					await runtime.commit(
						() =>
							drained
								? { status: "terminal", outcome: { status: "completed", result: {} } }
								: { status: "running", checkpoint: { phase: "wait" } },
						context,
					);
				},
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
		},
	);

	const extension = defineExtension({ name: "pilot.manual-compaction", tasks: [BarrierTask] });

	/** Active runs retain SDK turn-boundary compaction. Idle summaries append before queued input can start. */
	async function compactSession(
		harness: Harness,
		conversation: Conversation,
		instructions: string | undefined,
		context: Context,
	) {
		const reserved = await conversation.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversation.id);
			if (live.run) return false;
			const barrier = await tx.createTask(BarrierTask, {}, { ownership: { kind: "conversation" } });
			const child = await tx.createTask(
				CompactionTask,
				{ reason: "manual" as const, ...(instructions ? { instructions } : {}) },
				{ ownership: { kind: "task", taskId: barrier } },
			);
			live.compactions ??= [];
			live.compactions.push({ taskId: child, reason: "manual", blocking: true, attempt: 1 });
			return true;
		}, context);
		if (reserved) harness.resume();
		else await conversation.compact(instructions, context);
	}

	return { extension, compactSession };
}

/** Called on KernelSession's input line, which also serializes manual compaction admission. */
export async function queueDuringCompaction(
	harness: Harness,
	conversation: Conversation,
	requestId: string,
	content: UserInput,
	mode: DeliveryMode,
	context: Context,
) {
	const id = await conversation.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, conversation.id);
		if (live.run || !live.compactions?.some(({ reason }) => reason === "manual")) return undefined;
		const existing = await tx.submissionByRequest(conversation.id, requestId);
		if (existing) {
			if (existing.type !== "input") throw new Error(`Request ${requestId} already identifies a write`);
			return existing.id;
		}
		const submission = await tx.createSubmission({
			conversationId: conversation.id,
			requestId,
			type: "input",
			status: "queued",
		});
		(await tx.doc(InboxDoc, conversation.id)).items.push({ id: submission.id, mode, content });
		return submission.id;
	}, context);
	if (id === undefined) return undefined;
	harness.resume();
	return harness.submission(id, context);
}
