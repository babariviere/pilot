/** Stop parks automatic input outside pi.inbox, where neither abort nor a run boundary can consume it. */
import { type Context, copyJson } from "@earendil-works/chord";
import {
	ConversationBusy,
	type ConversationId,
	type Cursor,
	type EntryDraft,
	type EntryId,
	type Extension,
	GenerationTask,
	type Harness,
	hook,
	InboxDoc,
	type JsonObject,
	LiveDoc,
	type Session,
	type SubmissionId,
	ToolTask,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { DeliveryMode } from "@pilot/protocol";
import { HeldInputsDoc, type HeldInput as Input, type SystemMessageStateEvent } from "./held-inputs-doc.ts";
import { inputOrigin } from "./input-origin.ts";
import { QUESTION_ENTRY } from "./question-entry.ts";
import { previewText, type WithdrawnMessage } from "./queue.ts";

export { HeldInputsDoc, type SystemMessageStateEvent } from "./held-inputs-doc.ts";

/** A timed-out/cancelled script loses its stack, but its question still needs an explicit answer. */
export function questionBoundary(extension: Extension, session: () => Harness | undefined): Extension {
	return {
		...extension,
		hooks: [
			hook(GenerationTask, {
				afterTools: async (_assistant, results, api, context) => {
					const host = session();
					if (!host || !results.length) return;
					await finishQuestionReply(host, api.conversationId, context, results[results.length - 1]);
				},
			}),
			hook(ToolTask, {
				afterTool: async (call, result, api, context) => {
					if (call.parent) return;
					const held = await session()?.snapshot(HeldInputsDoc, api.conversationId, context);
					if (held?.blockingQuestion && held.questionPending)
						return { ...result, control: { ...result.control, terminate: true } };
				},
			}),
			...(extension.hooks ?? []),
		],
	};
}

/** Restore the reply's model contribution after the result, including after Stop/crash. */
export async function finishQuestionReply(
	session: Pick<Harness, "commit" | "snapshot">,
	conversationId: ConversationId,
	context: Context,
	resultId?: EntryId,
): Promise<void> {
	if (!(await session.snapshot(HeldInputsDoc, conversationId, context))?.questionReplies?.length) return;
	await session.commit(async (tx) => {
		const held = await tx.doc(HeldInputsDoc, conversationId);
		const answers = held.questionReplies;
		if (!answers?.length) return;
		let result = resultId ? await tx.entry(resultId) : undefined;
		if (!resultId) {
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanEntries({ conversationId }, 100, cursor);
				result = page.items.find((entry) => entry.kind === "pi.tool-result");
				cursor = page.next;
			} while (!result && cursor !== undefined);
		}
		if (!result) return;
		// The JS stack is never replayed. Its successful or interrupted result is
		// followed by the accepted reply, without a duplicate UI bubble.
		await tx.appendEntry(conversationId, {
			kind: "pilot.question-reply-context",
			model: [],
			edits: [
				{
					target: result.id,
					action: "replace",
					messages: [
						...(result.model ?? []),
						...answers.map((content) => ({ role: "user" as const, content, timestamp: Date.now() })),
					],
				},
			],
		});
		delete held.questionReplies;
		if (!held.questionPending) delete held.blockingQuestion;
	}, context);
}

/** Observe the committed reply, not a transport ACK or an automatic notification. No polling. */
export async function waitForQuestionAnswer(
	session: Pick<Harness, "watchDoc">,
	conversationId: ConversationId,
	callId: string,
	context: Context,
	signal?: AbortSignal,
): Promise<string> {
	const watch = await session.watchDoc(HeldInputsDoc, conversationId, context);
	if (!watch) throw new Error("Question is unavailable");
	let abort = () => {};
	try {
		return await new Promise<string>((resolve, reject) => {
			abort = () => reject(signal?.reason ?? new Error("Question cancelled"));
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			const check = (state: typeof watch.value) => {
				const question = state?.blockingQuestion;
				// Stop clears the gate before signalling the tool. Only the signal cancels the
				// await, so a script cannot catch a premature rejection and start another effect.
				if (question?.callId === callId && question.answer !== undefined) resolve(question.answer);
			};
			check(watch.value);
			watch.start(async (state) => check(state));
			void watch.closed.then(() => reject(new Error("Question watch closed")), reject);
		});
	} finally {
		signal?.removeEventListener("abort", abort);
		await watch.stop();
	}
}

/** Publish and fence the next boundary together, before a tool can return or suspend. */
export async function publishQuestionWithHeld(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	readSubmission: (id: SubmissionId) => Promise<{ requestId?: string } | undefined>,
	requestId: string,
	data: EntryDraft["data"],
	context: Context,
): Promise<void> {
	const published = await session.commit(async (tx) => {
		if (await tx.submissionByRequest(conversationId, requestId)) return true;
		const held = await tx.doc(HeldInputsDoc, conversationId);
		if (held.questionPending && held.blockingQuestion) return false;
		const blocking = typeof data === "object" && data !== null && !Array.isArray(data) && data.blocking === true;
		await holdQuestionInbox(tx, conversationId, readSubmission, blocking);
		if (blocking) held.blockingQuestion = { callId: requestId };
		const entry = await tx.appendEntry(conversationId, { kind: QUESTION_ENTRY, data, model: [] });
		await tx.createSubmission({ conversationId, requestId, type: "write", status: "done", entry: entry.id });
		return true;
	}, context);
	if (!published) throw new Error("Answer the pending question before asking another");
}

/** Recover legacy pending questions before the Harness or native notifications can resume. */
export async function initializeQuestionHold(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	readSubmission: (id: SubmissionId) => Promise<{ requestId?: string } | undefined>,
	context: Context,
): Promise<boolean> {
	return session.commit(async (tx) => {
		const held = await tx.doc(HeldInputsDoc, conversationId);
		const interrupted = !!held.blockingQuestion && !!held.questionPending;
		// Native tools are replay-unsafe. A replacement worker never resumes a script's JS stack.
		// Keep its unanswered question as a legacy next-turn question instead.
		// An accepted reply is restored at the recovered tool round's boundary.
		// It must survive until then, even if a crash interrupted the script's result.
		if (held.questionPending !== undefined) return interrupted;
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanEntries({ conversationId }, 100, cursor);
			for (const entry of page.items) {
				if (entry.kind === QUESTION_ENTRY) {
					await holdQuestionInbox(tx, conversationId, readSubmission);
					return false;
				}
				if (
					entry.kind !== "pi.compaction" &&
					entry.kind !== "pilot.activity" &&
					entry.model?.some((m) => m.role === "user")
				) {
					held.questionPending = false;
					return false;
				}
			}
			cursor = page.next;
		} while (cursor !== undefined);
		held.questionPending = false;
		return false;
	}, context);
}

async function holdQuestionInbox(
	tx: Tx,
	conversationId: ConversationId,
	readSubmission: (id: SubmissionId) => Promise<{ requestId?: string } | undefined>,
	blocking = false,
) {
	const held = await tx.doc(HeldInputsDoc, conversationId);
	const inbox = await tx.doc(InboxDoc, conversationId);
	const records = await Promise.all(inbox.items.map((item) => readSubmission(item.id)));
	// An already queued explicit user instruction is a response, not an automatic wake-up.
	held.questionPending =
		!held.stopped &&
		(blocking ||
			!inbox.items.some((item, index) => item.mode !== "write" && !inputOrigin(records[index]?.requestId)));
	if (held.questionPending) {
		inbox.items = inbox.items.filter((item, index) => {
			if (item.mode === "write") {
				if (
					item.entry.kind !== "pilot.activity" ||
					!Array.isArray(item.entry.model) ||
					!item.entry.model.some(
						(m) => typeof m === "object" && m !== null && !Array.isArray(m) && m.role === "user",
					)
				)
					return true;
				held.questionWrites ??= [];
				held.questionWrites.push(item);
			} else {
				held.items.push(item);
				notify(held, conversationId, records[index]?.requestId, "held", item.content);
			}
			return false;
		});
	}
}

/** Decision updates change model context but must not close the question or wake the model. */
export async function deferQuestionWrite(
	session: Pick<Session, "commit">,
	conversationId: ConversationId,
	requestId: string,
	entry: EntryDraft,
	context: Context,
): Promise<boolean> {
	return session.commit(async (tx) => {
		const held = await tx.doc(HeldInputsDoc, conversationId);
		if (!held.questionPending) return false;
		if (await tx.submissionByRequest(conversationId, requestId)) return true;
		const submission = await tx.createSubmission({ conversationId, requestId, type: "write", status: "queued" });
		held.questionWrites ??= [];
		held.questionWrites.push({
			id: submission.id,
			mode: "write",
			entry: copyJson(entry, { omitUndefinedProperties: true }) as JsonObject,
		});
		return true;
	}, context);
}

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
		held.questionPending = false;
		if (held.blockingQuestion?.answer === undefined) delete held.blockingQuestion;
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
	input: { requestId: string; content: Input["content"]; mode: DeliveryMode; entry?: Input["entry"] } | undefined,
	context: Context,
	onlyIfIdle = false,
	release = false,
	revision?: number,
): Promise<{ id?: SubmissionId; held?: boolean; started?: boolean } | undefined> {
	return session.commit(async (tx) => {
		const held = await tx.doc(HeldInputsDoc, conversationId);
		if (revision !== undefined && revision <= (held.controlRevision ?? 0)) return { started: false };
		if (
			!held.stopped &&
			!held.paused &&
			!held.questionPending &&
			!held.items.length &&
			!held.questionWrites?.length &&
			!release
		)
			return undefined;
		const existing = input ? await tx.submissionByRequest(conversationId, input.requestId) : undefined;
		if (existing) return { id: existing.id, held: held.items.some((item) => item.id === existing.id) };
		const live = await tx.doc(LiveDoc, conversationId);
		const inbox = await tx.doc(InboxDoc, conversationId);
		if (held.questionPending && !input) return { held: true };
		if (
			(held.questionPending && input && inputOrigin(input.requestId)) ||
			(!release && !held.questionPending && (held.paused || (input && inputOrigin(input.requestId))))
		) {
			if (!input) return { held: true };
			if (onlyIfIdle && !held.questionPending) throw new ConversationBusy(conversationId);
			const submission = await tx.createSubmission({
				conversationId,
				requestId: input.requestId,
				type: "input",
				status: "queued",
			});
			held.items.push({
				id: submission.id,
				mode: input.mode,
				content: input.content,
				...(input.entry ? { entry: input.entry } : {}),
			});
			notify(held, conversationId, input.requestId, "held", input.content);
			return { id: submission.id, held: true };
		}
		if (held.questionPending && input) {
			if (onlyIfIdle && (live.run || live.compactions?.length)) throw new ConversationBusy(conversationId);
			if (held.blockingQuestion && live.run) {
				// Notices enter model context at the tool boundary, after its result, not between
				// an assistant's tool calls and results (which provider APIs reject).
				inbox.items.push(...(held.questionWrites ?? []));
				const entry = await tx.appendEntry(UserEntry, conversationId, {
					model: [{ role: "user", content: input.content, timestamp: Date.now() }],
				});
				// Keep the visible reply bubble, but deliver its model content only through the
				// awaited tool result. A user message here would split the tool-call/result pair.
				await tx.appendEntry(conversationId, {
					kind: "pilot.question-reply",
					model: [],
					edits: [{ target: entry.id, action: "omit" }],
				});
				const submission = await tx.createSubmission({
					conversationId,
					requestId: input.requestId,
					type: "input",
					status: "done",
					entry: entry.id,
					answer: entry.id,
				});
				held.blockingQuestion.answer =
					typeof input.content === "string"
						? input.content
						: input.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
				held.questionReplies ??= [];
				held.questionReplies.push(held.blockingQuestion.answer);
				held.questionPending = false;
				held.questionWrites = [];
				if (!held.paused || release) {
					inbox.items.push(...held.items.map((item) => ({ ...item, mode: "followUp" as const })));
					held.items = [];
				}
				return { id: submission.id };
			}
			const submission = await tx.createSubmission({
				conversationId,
				requestId: input.requestId,
				type: "input",
				status: "queued",
			});
			const answer: Input = { id: submission.id, mode: "followUp", content: input.content };
			if (held.paused && !release) {
				held.items = [answer, ...held.items.map((item) => ({ ...item, mode: "followUp" as const }))];
				held.questionPending = false;
				return { id: submission.id, held: true };
			}
			// The user's answer starts alone. Deferred automatic input follows FIFO, never steering over it.
			if (live.run || live.compactions?.length) inbox.items.push(...(held.questionWrites ?? []), answer);
			else {
				for (const item of held.questionWrites ?? []) {
					const entry = await tx.appendEntry(conversationId, item.entry as unknown as EntryDraft);
					tx.placeSubmission(item.id, entry.id);
				}
				const entry = await tx.appendEntry(UserEntry, conversationId, {
					model: [{ role: "user", content: input.content, timestamp: Date.now() }],
				});
				tx.placeSubmission(submission.id, entry.id);
				live.run = {
					taskId: await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId }),
					inputs: [submission.id],
				};
			}
			held.questionWrites = [];
			inbox.items.push(...held.items.map((item) => ({ ...item, mode: "followUp" as const })));
			held.items = [];
			held.questionPending = false;
			return { id: submission.id, started: !live.compactions?.length };
		}
		if (release) {
			if (revision !== undefined) held.controlRevision = revision;
			held.paused = false;
			held.stopped = false;
			// Restore original queue modes for the next boundary, never create a second live run.
			if (!input && (live.run || live.compactions?.length)) {
				inbox.items.push(...(held.questionWrites ?? []));
				held.questionWrites = [];
				inbox.items.push(...held.items);
				held.items = [];
				return { started: false };
			}
		}
		// Stop waits for the old run to finish. Never splice held input into that run.
		if (live.run || live.compactions?.length || inbox.items.some((item) => item.mode !== "write"))
			throw new ConversationBusy(conversationId);
		for (const item of held.questionWrites ?? []) {
			const entry = await tx.appendEntry(conversationId, item.entry as unknown as EntryDraft);
			tx.placeSubmission(item.id, entry.id);
		}
		held.questionWrites = [];
		const items = [
			...held.items.filter((item) => item.mode === "steer"),
			...held.items.filter((item) => item.mode === "followUp"),
		];
		const ids: SubmissionId[] = [];
		for (const item of items) {
			const entry = await tx.appendEntry(conversationId, {
				kind: item.entry?.kind ?? UserEntry.kind,
				...(item.entry?.data !== undefined ? { data: item.entry.data } : {}),
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
