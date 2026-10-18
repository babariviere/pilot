/** Stop parks automatic input outside pi.inbox, where neither abort nor a run boundary can consume it. */
import type { Context } from "@earendil-works/chord";
import {
	ConversationBusy,
	type ConversationId,
	GenerationTask,
	InboxDoc,
	LiveDoc,
	type Session,
	type SubmissionId,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { DeliveryMode } from "@pilot/protocol";
import { HeldInputsDoc, type HeldInput as Input, type SystemMessageStateEvent } from "./held-inputs-doc.ts";
import { inputOrigin } from "./input-origin.ts";
import { previewText, type WithdrawnMessage } from "./queue.ts";

export { HeldInputsDoc, type SystemMessageStateEvent } from "./held-inputs-doc.ts";

function notify(
	state: { serial: number; events: SystemMessageStateEvent[] },
	conversationId: ConversationId,
	requestId: string | undefined,
	status: SystemMessageStateEvent["state"],
	content: Input["content"],
) {
	if (inputOrigin(requestId) !== "coordinator") return;
	state.events.push({
		id: `${conversationId}:${++state.serial}`,
		requestId: requestId!,
		state: status,
		preview: previewText(content),
	});
}

/** All selection happens on the mutation line, against the inbox that boundaries also mutate. */
export async function holdOnStop(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	readSubmission: (id: SubmissionId) => Promise<{ requestId?: string } | undefined>,
	context: Context,
): Promise<WithdrawnMessage[]> {
	return session.commit(async (tx) => {
		const inbox = await tx.doc(InboxDoc, conversationId);
		const held = await tx.doc(HeldInputsDoc, conversationId);
		const inputs = inbox.items.filter((item): item is Input => item.mode !== "write");
		const paused = held.paused ? held.items : [];
		const previous = new Set(paused.map((item) => item.id));
		inputs.unshift(...paused);
		if (held.paused) held.items = [];
		held.paused = false;
		const records = await Promise.all(inputs.map((item) => readSubmission(item.id)));
		held.stopped = true;
		const withdrawn: { mode: DeliveryMode; content: string; requestId?: string }[] = [];
		inputs.forEach((item, index) => {
			const requestId = records[index]?.requestId;
			if (inputOrigin(requestId)) {
				held.items.push(item);
				if (!previous.has(item.id)) notify(held, conversationId, requestId, "held", item.content);
			} else {
				tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
				const content =
					typeof item.content === "string"
						? item.content
						: item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
				withdrawn.push({ mode: item.mode, content, ...(requestId ? { requestId } : {}) });
			}
		});
		inbox.items = inbox.items.filter((item) => item.mode === "write");
		return [
			...withdrawn.filter((item) => item.mode === "steer"),
			...withdrawn.filter((item) => item.mode === "followUp"),
		]
			.filter((item) => item.content.trim())
			.map(({ mode: _, ...message }) => message);
	}, context);
}

/** Share the inbox mutation line with run boundaries. The current run is not cancelled. */
export async function pauseInputs(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	context: Context,
	revision?: number,
): Promise<void> {
	await session.commit(async (tx) => {
		const inbox = await tx.doc(InboxDoc, conversationId);
		const held = await tx.doc(HeldInputsDoc, conversationId);
		if (revision !== undefined) {
			if (revision <= (held.controlRevision ?? 0)) return;
			held.controlRevision = revision;
		}
		held.paused = true;
		held.items.push(...inbox.items.filter((item): item is Input => item.mode !== "write"));
		inbox.items = inbox.items.filter((item) => item.mode === "write");
	}, context);
}

/** Specialized admission only while stopped/holding. Normal admission stays with Conversation.submit. */
export async function admitWithHeld(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	input: { requestId: string; content: Input["content"]; mode: DeliveryMode } | undefined,
	context: Context,
	onlyIfIdle = false,
	release = false,
	revision?: number,
): Promise<{ id?: SubmissionId; held?: boolean; started?: boolean } | undefined> {
	return session.commit(async (tx) => {
		const held = await tx.doc(HeldInputsDoc, conversationId);
		if (revision !== undefined && revision <= (held.controlRevision ?? 0)) return { started: false };
		if (!held.stopped && !held.paused && !held.items.length && !release) return undefined;
		const existing = input ? await tx.submissionByRequest(conversationId, input.requestId) : undefined;
		if (existing) return { id: existing.id, held: held.items.some((item) => item.id === existing.id) };
		const live = await tx.doc(LiveDoc, conversationId);
		const inbox = await tx.doc(InboxDoc, conversationId);
		if (!release && (held.paused || (input && inputOrigin(input.requestId)))) {
			if (!input) return { held: true };
			if (onlyIfIdle) throw new ConversationBusy(conversationId);
			const submission = await tx.createSubmission({
				conversationId,
				requestId: input.requestId,
				type: "input",
				status: "queued",
			});
			held.items.push({ id: submission.id, mode: input.mode, content: input.content });
			notify(held, conversationId, input.requestId, "held", input.content);
			return { id: submission.id, held: true };
		}
		if (release) {
			if (revision !== undefined) held.controlRevision = revision;
			held.paused = false;
			held.stopped = false;
			// Restore original queue modes for the next boundary, never create a second live run.
			if (!input && (live.run || live.compactions?.length)) {
				inbox.items.push(...held.items);
				held.items = [];
				return { started: false };
			}
		}
		// Stop waits for the old run to finish. Never splice held input into that run.
		if (live.run || live.compactions?.length || inbox.items.some((item) => item.mode !== "write"))
			throw new ConversationBusy(conversationId);
		const items = [
			...held.items.filter((item) => item.mode === "steer"),
			...held.items.filter((item) => item.mode === "followUp"),
		];
		const ids: SubmissionId[] = [];
		for (const item of items) {
			const entry = await tx.appendEntry(UserEntry, conversationId, {
				model: [{ role: "user", content: item.content, timestamp: Date.now() }],
			});
			tx.placeSubmission(item.id, entry.id);
			ids.push(item.id);
		}
		let id: SubmissionId | undefined;
		if (input) {
			const entry = await tx.appendEntry(UserEntry, conversationId, {
				model: [{ role: "user", content: input.content, timestamp: Date.now() }],
			});
			id = (
				await tx.createSubmission({
					conversationId,
					requestId: input.requestId,
					type: "input",
					status: "placed",
					entry: entry.id,
				})
			).id;
			ids.push(id);
		}
		if (!ids.length) return { started: false };
		held.items = [];
		held.stopped = false;
		live.run = {
			taskId: await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId }),
			inputs: ids,
		};
		return { ...(id ? { id } : {}), started: true };
	}, context);
}

export async function discardHeld(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	readSubmission: (id: SubmissionId) => Promise<{ requestId?: string } | undefined>,
	context: Context,
	id?: number,
) {
	if (id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid held message ID");
	await session.commit(async (tx) => {
		const held = await tx.doc(HeldInputsDoc, conversationId);
		const items = held.items.filter((item) => id === undefined || item.id === id);
		const records = await Promise.all(items.map((item) => readSubmission(item.id)));
		const discarded = new Set<SubmissionId>();
		items.forEach((item, index) => {
			// The app's system-message Discard action must not delete paused user queue rows.
			if (!inputOrigin(records[index]?.requestId)) return;
			tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
			notify(held, conversationId, records[index]?.requestId, "discarded", item.content);
			discarded.add(item.id);
		});
		held.items = held.items.filter((item) => !discarded.has(item.id));
	}, context);
}
