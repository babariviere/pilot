/** Automatic, restart-stable settled-run outcomes. */
import type { Context } from "@earendil-works/chord";
import {
	type Conversation,
	type Cursor,
	defineDoc,
	type EntryId,
	type Harness,
	type Storage,
	type SubmissionId,
	type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { SessionCompletion } from "@pilot/protocol";
import { safeFailureText } from "./failure.ts";
import { QUESTION_ENTRY } from "./question-entry.ts";

/** A question ends its run, so only the run's last few entries can hold it (codemode adds a result and a reply). */
const QUESTION_TAIL = 8;
const QUESTION_REASON_LENGTH = 300;

type StoredCompletion = Omit<SessionCompletion, "outcome"> & {
	// Read older sessions without exposing the retired human-attention outcome.
	outcome: SessionCompletion["outcome"] | "needs_input";
	input: number;
	entry: number;
};

type AttentionState = { completion?: StoredCompletion };

export function normalizeCompletion(
	completion: StoredCompletion,
): SessionCompletion & { input: number; entry: number } {
	if (completion.outcome !== "needs_input") return { ...completion, outcome: completion.outcome };
	const { outcomeReason: _reason, ...settled } = completion;
	return { ...settled, outcome: "done" };
}

export const AttentionDoc = defineDoc<AttentionState>({
	kind: "pilot.attention",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

export function classifyCompletion(record: SubmissionRecord): Omit<SessionCompletion, "outcomeAt"> {
	if (record.status === "unanswered") {
		if (record.reason === "aborted" || record.reason === "reset") return { outcome: "stopped" };
		return {
			outcome: "failed",
			outcomeReason: safeFailureText(typeof record.detail === "string" ? record.detail : record.reason),
		};
	}
	if (record.status !== "done" || record.type !== "input") throw new Error("Input has not settled");
	return { outcome: "done" };
}

/**
 * The question asked at the end of the run started by input entry `after`, if any. A question followed by a user
 * message was already answered within the run.
 */
export async function askedQuestion(
	conversation: Conversation,
	after: number,
	context: Context,
): Promise<string | undefined> {
	const page = await conversation.entries({ minEntryId: (after + 1) as EntryId }, QUESTION_TAIL, undefined, context);
	for (const entry of page.items) {
		if (entry.kind === QUESTION_ENTRY) {
			const question = (entry.data as { question?: unknown } | undefined)?.question;
			return typeof question === "string" && question.trim()
				? question.trim().replace(/\s+/g, " ").slice(0, QUESTION_REASON_LENGTH)
				: "";
		}
		if (entry.model?.some((message) => message.role === "user")) return undefined;
	}
	return undefined;
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
	if (!latest || (attention?.completion && attention.completion.entry >= latest.entry!))
		return attention?.completion ? normalizeCompletion(attention.completion) : undefined;
	const record = latest;
	const classified = classifyCompletion(record);
	const question =
		classified.outcome === "done" ? await askedQuestion(conversation, record.entry!, context) : undefined;
	return conversation.commit(async (tx) => {
		const state = await tx.doc(AttentionDoc, conversation.id);
		if (state.completion && state.completion.entry >= record.entry!) return normalizeCompletion(state.completion);
		const completion = {
			...(question === undefined
				? classified
				: { outcome: "question" as const, ...(question ? { outcomeReason: question } : {}) }),
			outcomeAt: Math.max(Date.now(), (state.completion?.outcomeAt ?? 0) + 1),
			input: record.id,
			entry: record.entry!,
		};
		state.completion = completion;
		return completion;
	}, context);
}
