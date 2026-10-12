/**
 * Conversation attempts. A session continues one conversation at a time. Retry, edit and restore fork the active
 * conversation at an earlier entry and switch to the fork; earlier attempts stay in storage and can be activated again.
 * Workspace files are never reverted.
 */
import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	type Cursor,
	defineDoc,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
	type Storage,
} from "@earendil-works/pi-durable";
import type { RewindAction, SessionAttempt } from "@pilot/protocol";

export type AttemptRecord = {
	id: number;
	reason: RewindAction;
	createdAt: number;
	/** Start of the resent message, for retry and edit. */
	preview?: string;
	/** Holds nothing but failed or stopped turns. Decided when the session leaves the attempt. */
	hidden?: boolean;
};

export type AttemptsState = {
	/** The conversation the session continues. */
	active: number;
	/** Forks, oldest first. The root conversation is the implicit original. */
	attempts: AttemptRecord[];
};

/** Session-scoped, so it survives switching conversations. */
export const AttemptsDoc = defineDoc<AttemptsState>({
	kind: "pilot.attempts",
	version: 1,
	scope: "session",
	initial: () => ({ active: ROOT_CONVERSATION_ID, attempts: [] }),
});

/** Bounded display list. The original and the active attempt are always included. */
export const MAX_LISTED_ATTEMPTS = 20;
export const PREVIEW_LENGTH = 120;

type Reader = Pick<Storage, "findDocument" | "document" | "conversation">;

/** Read-only, for kernels and cold readers alike. */
export async function readAttempts(storage: Reader, context: Context): Promise<AttemptsState | undefined> {
	const record = await storage.findDocument(
		{ kind: AttemptsDoc.definition.kind, scope: { kind: "session" } },
		"current",
		context,
	);
	if (!record) return undefined;
	return (await storage.document(record.id, "current", context))?.value as AttemptsState | undefined;
}

/** The conversation the session continues. Missing or legacy state means the root conversation. */
export async function activeConversation(storage: Reader, context: Context): Promise<ConversationId> {
	const active = (await readAttempts(storage, context))?.active as ConversationId | undefined;
	if (active === undefined || active === ROOT_CONVERSATION_ID) return ROOT_CONVERSATION_ID;
	return (await storage.conversation(active, context)) ? active : ROOT_CONVERSATION_ID;
}

/** The conversation and the ancestors it inherits history from, nearest first. */
export async function lineage(
	storage: Pick<Storage, "conversation">,
	id: ConversationId,
	context: Context,
): Promise<ConversationId[]> {
	const ids: ConversationId[] = [];
	for (let next: ConversationId | undefined = id; next !== undefined && !ids.includes(next); ) {
		ids.push(next);
		next = (await storage.conversation(next, context))?.parent?.conversationId;
	}
	return ids;
}

/** Attempts for clients, oldest first. Undefined while the original is the only one worth showing. */
export function publicAttempts(state: Readonly<AttemptsState> | undefined): SessionAttempt[] | undefined {
	if (!state) return undefined;
	const visible = state.attempts.filter((attempt) => !attempt.hidden || attempt.id === state.active);
	if (!visible.length) return undefined;
	const listed = visible.slice(-MAX_LISTED_ATTEMPTS);
	const active = visible.find((attempt) => attempt.id === state.active);
	if (active && !listed.includes(active)) listed.splice(0, 1, active);
	return [
		{ id: String(ROOT_CONVERSATION_ID), ...(state.active === ROOT_CONVERSATION_ID ? { active: true } : {}) },
		...listed.map((attempt) => ({
			id: String(attempt.id),
			reason: attempt.reason,
			createdAt: attempt.createdAt,
			...(attempt.preview ? { preview: attempt.preview } : {}),
			...(attempt.id === state.active ? { active: true } : {}),
		})),
	];
}

/** Text of a user entry. Pilot sends image attachments as paths inside the text. */
export function userText(entry: EntryRecord): string {
	return (entry.model ?? [])
		.flatMap((message) =>
			message.role !== "user"
				? []
				: typeof message.content === "string"
					? [message.content]
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		)
		.join("\n");
}

function failedOrStopped(entry: EntryRecord): boolean {
	return (
		entry.kind === "pi.assistant" &&
		(entry.model ?? []).every(
			(message) =>
				message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"),
		)
	);
}

/** Work worth keeping in an attempt: an answer, a tool result or a published artifact. */
function keepsWork(entry: EntryRecord): boolean {
	return (
		entry.kind === "pi.tool-result" ||
		entry.kind === "pilot.artifact" ||
		(entry.kind === "pi.assistant" && !failedOrStopped(entry))
	);
}

/** True for a fork whose own entries are only messages and failed or stopped turns. The original is always kept. */
export async function holdsOnlyFailedTurns(
	storage: Pick<Storage, "conversation" | "scanEntries">,
	id: ConversationId,
	context: Context,
): Promise<boolean> {
	if (id === ROOT_CONVERSATION_ID) return false;
	const record = await storage.conversation(id, context);
	if (!record) return false;
	// Starting after the fork point stops the scan before it reaches inherited entries.
	const query: EntryQuery = {
		conversationId: id,
		...(record.parent ? { minEntryId: (record.parent.at + 1) as EntryId } : {}),
	};
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries(query, 64, cursor, context);
		if (page.items.some((entry) => entry.conversationId === id && keepsWork(entry))) return false;
		cursor = page.next;
	} while (cursor !== undefined);
	return true;
}

export interface RewindPlan {
	/** Last inherited entry. Undefined starts an empty conversation, when nothing precedes the first message. */
	at?: EntryId;
	/** The conversation that owns `at`. Forking it rather than the active fork keeps ancestry short. */
	from?: ConversationId;
	/** The message retry resends and edit returns to the composer. */
	content?: string;
}

/** Newest-first scan for the first entry that matches. */
async function newest(
	storage: Pick<Storage, "scanEntries">,
	query: EntryQuery,
	match: (entry: EntryRecord) => boolean,
	context: Context,
): Promise<EntryRecord | undefined> {
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries(query, 64, cursor, context);
		const found = page.items.find(match);
		if (found) return found;
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

/** Oldest matching entry. Scans the whole range, which is bounded by the visible history after a point. */
async function oldest(
	storage: Pick<Storage, "scanEntries">,
	query: EntryQuery,
	match: (entry: EntryRecord) => boolean,
	context: Context,
): Promise<EntryRecord | undefined> {
	let found: EntryRecord | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries(query, 64, cursor, context);
		for (const entry of page.items) if (match(entry) && (!found || entry.id < found.id)) found = entry;
		cursor = page.next;
	} while (cursor !== undefined);
	return found;
}

const isUser = (entry: EntryRecord) => entry.kind === "pi.user";

/**
 * Where an attempt continues from. Edit and retry continue from just before a user message, so the model never sees
 * it; restore continues from the last entry before the next user message, the end of the chosen turn, so no tool
 * call is left without its result.
 */
export async function planRewind(
	storage: Pick<Storage, "entry" | "scanEntries">,
	conversationId: ConversationId,
	action: RewindAction,
	entryId: number,
	context: Context,
): Promise<RewindPlan> {
	if (!Number.isSafeInteger(entryId) || entryId < 1) throw new Error("Invalid entry ID");
	const target = (await storage.entry(conversationId, entryId as EntryId, context))?.entry;
	if (!target) throw new Error("The message is not part of this conversation");
	const before = async (id: EntryId): Promise<RewindPlan> => {
		const previous = (
			await storage.scanEntries({ conversationId, maxEntryId: (id - 1) as EntryId }, 1, undefined, context)
		).items[0];
		return previous ? { at: previous.id, from: previous.conversationId } : {};
	};
	if (action === "restore") {
		if (target.kind !== "pi.assistant") throw new Error("Only an agent message can be restored");
		const next = await oldest(storage, { conversationId, minEntryId: (entryId + 1) as EntryId }, isUser, context);
		if (!next) throw new Error("This is already the latest point of the conversation");
		return before(next.id);
	}
	let user: EntryRecord | undefined;
	if (action === "edit") {
		if (!isUser(target)) throw new Error("Only a user message can be edited");
		user = target;
	} else if (action === "retry") {
		user = await newest(storage, { conversationId, maxEntryId: entryId as EntryId }, isUser, context);
		if (!user) throw new Error("There is no message to retry");
	} else {
		throw new Error(`Unknown rewind action: ${String(action)}`);
	}
	const content = userText(user);
	if (!content.trim()) throw new Error("The message has no text to resend");
	return { ...(await before(user.id)), content };
}
