/** A tool-free side reply in the original kernel. It never admits input or releases the question hold. */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type Cursor,
	defineDoc,
	type Session,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { QUESTION_ENTRY } from "../../history/entry-kinds.ts";
import { HeldInputsDoc } from "../../session/input/held-inputs-doc.ts";
import { findInputReceipt } from "../../history/storage.ts";

export interface ClarificationRequest {
	operationId: string;
	questionId: number;
	question: string;
}
export interface QuestionClarification extends ClarificationRequest {
	answer: string;
}
export interface ClarificationContext {
	original: unknown;
	question: string;
	previous: QuestionClarification[];
}
// Match the native question editor; limit prompt cost, not saved discussion length.
const QUESTION_BYTES = 8000;
// A 1024-token text reply normally fits well below this UI/read-receipt ceiling.
const ANSWER_BYTES = 16000;
const intentId = (id: string) => `native:question-clarification:intent:${id}`;
const resultId = (id: string) => `native:question-clarification:result:${id}`;
const ClarificationDoc = defineDoc<{ pending?: { operationId: string; questionId: number } }>({
	kind: "pilot.question-clarification",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => false,
});

async function originalQuestion(tx: Tx, conversationId: ConversationId, questionId: number) {
	const held = await tx.doc(HeldInputsDoc, conversationId);
	if (held.stopped || held.paused || held.planning) throw new Error("Chat is stopped or paused");
	if (!held.questionPending || held.interviewPending) throw new Error("Original question changed");
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanEntries({ conversationId }, 64, cursor);
		const question = page.items.find((entry) => entry.kind === QUESTION_ENTRY);
		if (question) {
			if (Number(question.id) !== questionId) throw new Error("Original question changed");
			return question.data;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	throw new Error("Original question changed");
}

function result(data: unknown): QuestionClarification {
	if (
		!data ||
		typeof data !== "object" ||
		!("answer" in data) ||
		typeof data.answer !== "string" ||
		!("question" in data) ||
		typeof data.question !== "string" ||
		!("operationId" in data) ||
		typeof data.operationId !== "string" ||
		!("questionId" in data) ||
		typeof data.questionId !== "number"
	)
		throw new Error("Invalid clarification receipt");
	return { answer: data.answer, question: data.question, operationId: data.operationId, questionId: data.questionId };
}

/** Passive recovery can only read the exact committed result, never send the request again. */
export async function readQuestionClarification(
	storage: Storage,
	operationId: string,
): Promise<QuestionClarification | undefined> {
	const receipt = await findInputReceipt(storage, resultId(operationId), context);
	if (!receipt?.entry) return undefined;
	const entry = (await storage.entry(receipt.entry, context))?.entry;
	if (entry?.kind !== "pilot.question-clarification") throw new Error("Invalid clarification receipt");
	const saved = result(entry.data);
	if (saved.operationId !== operationId) throw new Error("Clarification identity changed");
	return saved;
}

export class QuestionClarifications {
	private active?: { controller: AbortController; done: Promise<QuestionClarification> };
	private readonly session: Pick<Session, "commit">;
	private readonly conversationId: ConversationId;
	private readonly generate: (source: ClarificationContext, signal: AbortSignal) => Promise<string>;
	private readonly guard: () => void | Promise<void>;
	constructor(
		session: Pick<Session, "commit">,
		conversationId: ConversationId,
		generate: (source: ClarificationContext, signal: AbortSignal) => Promise<string>,
		guard: () => void | Promise<void> = () => {},
	) {
		this.session = session;
		this.conversationId = conversationId;
		this.generate = generate;
		this.guard = guard;
	}

	request(request: ClarificationRequest): Promise<QuestionClarification> {
		if (this.active) return Promise.reject(new Error("A clarification is already in progress"));
		if (
			!/^[A-Za-z0-9_-]{1,128}$/.test(request.operationId) ||
			!Number.isSafeInteger(request.questionId) ||
			request.questionId <= 0
		)
			return Promise.reject(new Error("Invalid clarification identity"));
		if (!request.question.trim()) return Promise.reject(new Error("Write a clarification question first"));
		const bytes = Buffer.byteLength(request.question);
		if (bytes > QUESTION_BYTES)
			return Promise.reject(
				new Error(`Clarification holds at most ${QUESTION_BYTES} UTF-8 bytes; got ${bytes}. Shorten the question.`),
			);
		const controller = new AbortController();
		const done = this.perform(request, controller.signal).finally(() => {
			if (this.active?.done === done) this.active = undefined;
		});
		this.active = { controller, done };
		return done;
	}

	async stop(): Promise<void> {
		const active = this.active;
		if (!active) return;
		active.controller.abort(new Error("Clarification cancelled by control"));
		await active.done.catch(() => undefined);
	}

	private async perform(request: ClarificationRequest, signal: AbortSignal): Promise<QuestionClarification> {
		const prepared = await this.session.commit(async (tx) => {
			const prior = await tx.submissionByRequest(this.conversationId, intentId(request.operationId));
			if (prior?.entry) {
				const entry = await tx.entry(prior.entry);
				if (JSON.stringify(entry?.data) !== JSON.stringify(request)) throw new Error("Clarification bytes changed");
				const ready = await tx.submissionByRequest(this.conversationId, resultId(request.operationId));
				if (!ready?.entry) throw new Error("Unknown clarification outcome; inspect the original attempt");
				return { saved: result((await tx.entry(ready.entry))?.data) };
			}
			signal.throwIfAborted();
			await this.guard();
			const original = await originalQuestion(tx, this.conversationId, request.questionId);
			const previous: QuestionClarification[] = [];
			let historyBytes = 0;
			// One metadata page finds recent replies. Keep whole exchanges within half the 32 KiB prompt.
			for (const entry of (await tx.scanEntries({ conversationId: this.conversationId }, 64)).items) {
				if (entry.kind !== "pilot.question-clarification") continue;
				const saved = result(entry.data);
				if (saved.questionId !== request.questionId) continue;
				const size = Buffer.byteLength(JSON.stringify(saved));
				if (historyBytes + size > 16384) break;
				previous.unshift(saved);
				historyBytes += size;
			}
			const state = await tx.doc(ClarificationDoc, this.conversationId);
			if (state.pending?.questionId === request.questionId)
				throw new Error("Unknown earlier clarification; inspect it before asking again");
			state.pending = { operationId: request.operationId, questionId: request.questionId };
			const entry = await tx.appendEntry(this.conversationId, {
				kind: "pilot.question-clarification-intent",
				data: { ...request },
				model: [],
			});
			await tx.createSubmission({
				conversationId: this.conversationId,
				requestId: intentId(request.operationId),
				type: "write",
				status: "done",
				entry: entry.id,
			});
			return { original, previous };
		}, context);
		if (prepared.saved) return prepared.saved;
		signal.throwIfAborted();
		await this.guard();
		const answer = (
			await this.generate(
				{ original: prepared.original, question: request.question, previous: prepared.previous ?? [] },
				signal,
			)
		).trim();
		if (!answer) throw new Error("Clarification reply is empty");
		if (Buffer.byteLength(answer) > ANSWER_BYTES)
			throw new Error(
				`Clarification reply holds at most ${ANSWER_BYTES} UTF-8 bytes; got ${Buffer.byteLength(answer)}. Use the original reply field instead.`,
			);
		const saved: QuestionClarification = { ...request, answer };
		await this.session.commit(async (tx) => {
			signal.throwIfAborted();
			await this.guard();
			await originalQuestion(tx, this.conversationId, request.questionId);
			const state = await tx.doc(ClarificationDoc, this.conversationId);
			if (state.pending?.operationId !== request.operationId) throw new Error("Clarification identity changed");
			const entry = await tx.appendEntry(this.conversationId, {
				kind: "pilot.question-clarification",
				data: { ...saved },
				model: [],
			});
			await tx.createSubmission({
				conversationId: this.conversationId,
				requestId: resultId(request.operationId),
				type: "write",
				status: "done",
				entry: entry.id,
			});
			delete state.pending;
		}, context);
		return saved;
	}
}
