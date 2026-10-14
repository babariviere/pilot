import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	type DocumentObserver,
	InboxDoc,
	type InboxState,
	type Session,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import type { PendingAutomaticInput, QueueUpdateEvent } from "@pilot/protocol";
import { inputOrigin } from "./input-origin.ts";

export function queueUpdate(inbox: Readonly<InboxState> | null): QueueUpdateEvent {
	return {
		type: "queue_update",
		items: (inbox?.items ?? []).flatMap((item) =>
			item.mode === "write" ? [] : [{ id: item.id, mode: item.mode, content: item.content }],
		),
	};
}

/**
 * Automatic input (job and extension notifications, mission messages and notices, PR follow-ups) still reaches the
 * agent, but the queue only shows the user's own editable messages. Automatic input is listed separately in
 * `automatic`, read-only. `pendingSince` keeps each automatic item's first-seen time across updates; pass one map per
 * session so every watch reports the same `queuedAt`. Without it (cold reads) `queuedAt` is omitted.
 */
export async function queueUpdateForDisplay(
	inbox: Readonly<InboxState> | null,
	readSubmission: (id: SubmissionId) => Promise<{ requestId?: string } | undefined>,
	pendingSince?: Map<number, number>,
	now = Date.now(),
): Promise<QueueUpdateEvent> {
	const event = queueUpdate(inbox);
	const origins = await Promise.all(
		event.items.map(async (item) => inputOrigin((await readSubmission(item.id as SubmissionId))?.requestId)),
	);
	const automatic: PendingAutomaticInput[] = [];
	event.items.forEach((item, index) => {
		const origin = origins[index];
		if (origin === undefined) return;
		const input: PendingAutomaticInput = { id: item.id, origin, mode: item.mode, preview: previewText(item.content) };
		if (pendingSince) {
			input.queuedAt = pendingSince.get(item.id) ?? now;
			pendingSince.set(item.id, input.queuedAt);
		}
		automatic.push(input);
	});
	if (pendingSince) {
		// Bounded by the inbox: forget items that joined a run or were withdrawn.
		const pending = new Set(automatic.map((item) => item.id));
		for (const id of pendingSince.keys()) if (!pending.has(id)) pendingSince.delete(id);
	}
	return { ...event, items: event.items.filter((_, index) => origins[index] === undefined), automatic };
}

const PREVIEW_LIMIT = 200;

/** First non-empty line, clamped, for the read-only waiting list. */
export function previewText(content: unknown): string {
	const text = messageText(content);
	let line = "";
	for (const candidate of text.split("\n")) {
		line = candidate.trim();
		if (line) break;
	}
	const characters = Array.from(line);
	return characters.length > PREVIEW_LIMIT ? `${characters.slice(0, PREVIEW_LIMIT - 1).join("")}…` : line;
}

/** Withdraw one pending input atomically with consumption, without aborting the active run. */
export async function removeQueuedMessage(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	submissionId: number,
	context: Context,
): Promise<void> {
	if (!Number.isSafeInteger(submissionId) || submissionId <= 0) throw new Error("Invalid queued message ID");
	await session.commit(async (tx) => {
		const inbox = await tx.doc(InboxDoc, conversationId);
		const index = inbox.items.findIndex((item) => item.id === submissionId);
		const item = inbox.items[index];
		if (!item || item.mode === "write") throw new Error("Message is no longer queued. It has not been removed.");
		// Match pi-durable's queued withdrawal semantics, including waiter publication.
		tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
		inbox.items.splice(index, 1);
	}, context);
}

/** A message withdrawn by Stop, for the composer. */
export interface WithdrawnMessage {
	requestId?: string;
	content: string;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("\n");
}

/**
 * Withdraw the user's own queued messages before Stop aborts, and return their text in delivery order (steering, then
 * follow-ups). Withdrawal shares the inbox mutation line with consumption, so a returned message was never delivered.
 * Automatic input is left for the abort, which withdraws it as before.
 */
export async function withdrawUserMessages(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	inbox: Readonly<InboxState> | null,
	readSubmission: (id: SubmissionId) => Promise<{ requestId?: string } | undefined>,
	context: Context,
): Promise<WithdrawnMessage[]> {
	const visible = (await queueUpdateForDisplay(inbox, readSubmission)).items;
	if (!visible.length) return [];
	const requestIds = new Map<number, string | undefined>();
	await Promise.all(
		visible.map(async (item) => {
			requestIds.set(item.id, (await readSubmission(item.id as SubmissionId))?.requestId);
		}),
	);
	const withdrawn = await session.commit(async (tx) => {
		const inbox = await tx.doc(InboxDoc, conversationId);
		const taken: { mode: "steer" | "followUp"; message: WithdrawnMessage }[] = [];
		for (let index = 0; index < inbox.items.length; ) {
			const item = inbox.items[index]!;
			if (item.mode === "write" || !requestIds.has(item.id)) {
				index++;
				continue;
			}
			tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
			inbox.items.splice(index, 1);
			const requestId = requestIds.get(item.id);
			taken.push({
				mode: item.mode,
				message: { ...(requestId !== undefined ? { requestId } : {}), content: messageText(item.content) },
			});
		}
		return taken;
	}, context);
	return [
		...withdrawn.filter((item) => item.mode === "steer"),
		...withdrawn.filter((item) => item.mode !== "steer"),
	].flatMap((item) => (item.message.content.trim() ? [item.message] : []));
}

/** Exact committed inbox frames, independent of the agent stream's content-free queue IDs. */
export async function watchQueue(observer: DocumentObserver, conversationId: ConversationId, context: Context) {
	const watch = await observer.watchDoc(InboxDoc, conversationId, context);
	if (!watch) throw new Error("Conversation inbox is missing");
	return watch;
}

/**
 * Replace pending content, and optionally the delivery mode, on the mutation line. Never withdraw/resubmit or change
 * history. Boundaries read each item's mode when they run, so a changed mode applies from the next boundary.
 */
export async function editQueuedMessage(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	submissionId: number,
	content: string,
	context: Context,
	mode?: "steer" | "followUp",
): Promise<void> {
	if (!Number.isSafeInteger(submissionId) || submissionId <= 0) throw new Error("Invalid queued message ID");
	if (typeof content !== "string" || !content.trim()) throw new Error("message is required");
	if (mode !== undefined && mode !== "steer" && mode !== "followUp") throw new Error("mode must be steer or followUp");
	await session.commit(async (tx) => {
		// Admission, consumption, and withdrawal all mutate this conversation's inbox on the same line.
		const inbox = await tx.doc(InboxDoc, conversationId);
		const item = inbox.items.find((item) => item.id === submissionId);
		if (!item || item.mode === "write") throw new Error("Message is no longer queued. Your edit has not been sent.");
		item.content = content;
		if (mode !== undefined) item.mode = mode;
	}, context);
}
