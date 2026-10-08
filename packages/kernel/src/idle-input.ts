/** Atomic idle-only specialization of pi-durable 1.0.4 input admission, using its public transaction API. */
import type { Context } from "@earendil-works/chord";
import {
	type Conversation,
	ConversationBusy,
	GenerationTask,
	type Harness,
	InboxDoc,
	LiveDoc,
	UserEntry,
} from "@earendil-works/pi-durable";

export async function submitIdleInput(
	harness: Harness,
	conversation: Conversation,
	requestId: string,
	content: string,
	context: Context,
): Promise<void> {
	await conversation.commit(async (tx) => {
		const existing = await tx.submissionByRequest(conversation.id, requestId);
		if (existing) {
			if (existing.type !== "input")
				throw new Error(`Request ${requestId} already identifies a submission of type ${existing.type}`);
			return;
		}
		const live = await tx.doc(LiveDoc, conversation.id);
		const inbox = await tx.doc(InboxDoc, conversation.id);
		if (live.run || live.compactions?.length || inbox.items.length) throw new ConversationBusy(conversation.id);
		// These are pi-durable's idle input placement and startRun operations in the SAME commit as the guard.
		// The Harness still owns scheduling, generation, settlement and recovery; no native model loop is started.
		const entry = await tx.appendEntry(UserEntry, conversation.id, {
			model: [{ role: "user", content, timestamp: Date.now() }],
		});
		const submission = await tx.createSubmission({
			conversationId: conversation.id,
			requestId,
			type: "input",
			status: "placed",
			entry: entry.id,
		});
		live.run = {
			taskId: await tx.createTask(
				GenerationTask,
				{},
				{ ownership: { kind: "conversation" }, conversationId: conversation.id },
			),
			inputs: [submission.id],
		};
	}, context);
	harness.resume();
}
