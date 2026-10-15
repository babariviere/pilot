/** Cold transcript viewing, with no agent initialization. Only compaction statistics need the lazy SDK estimator. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type ConversationId,
	type Cursor,
	createSession,
	type EntryRecord,
	InboxDoc,
	LiveDoc,
	type Storage,
	UsageDoc,
} from "@earendil-works/pi-durable";
import type { AgentEvent, SessionCompletion } from "@pilot/protocol";
import { activeConversation, lineage } from "./attempts.ts";
import { AttentionDoc, normalizeCompletion } from "./attention.ts";
import { chatEventEntries } from "./chat-events.ts";
import { GitHubActionsDoc } from "./github-actions.ts";
import { HeldInputsDoc } from "./held-inputs.ts";
import { InputOrigins } from "./input-origin.ts";
import { queueUpdate, queueUpdateForDisplay } from "./queue.ts";
import { openSessionReader } from "./storage.ts";
import { TodosWatch, todosDirectory } from "./todos.ts";

export interface PersistedSessionView {
	events: AgentEvent[];
	/** Only the persisted version, never a synthesized completion or a new outcome timestamp. */
	completion?: SessionCompletion;
}

const context = BACKGROUND_CONTEXT;

/** The durable structural view of one conversation, as a single snapshot event plus its queue. */
async function conversationView(
	storage: Storage,
	id: ConversationId,
): Promise<{ events: AgentEvent[]; completion?: SessionCompletion }> {
	const session = createSession(storage);
	try {
		// Match the durable structural view: newest head marker first, then all retained
		// non-head entries. Compaction/reset history is not the active transcript.
		const head = await storage.findLatestHeadMarker(id, undefined, context);
		const range: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanEntries(
				{ conversationId: id, ...(head ? { minEntryId: head.head } : {}) },
				256,
				cursor,
				context,
			);
			range.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		range.reverse();
		const [agent, live, inbox, usage, attention] = await Promise.all([
			session.snapshot(AgentDoc, id, context),
			session.snapshot(LiveDoc, id, context),
			session.snapshot(InboxDoc, id, context),
			session.snapshot(UsageDoc, id, context),
			session.snapshot(AttentionDoc, id, context),
		]);
		const snapshot: AgentEvent = {
			type: "snapshot",
			entries: await chatEventEntries(
				session,
				await new InputOrigins(storage, await lineage(storage, id, context), context).entries(
					head ? [head, ...range.filter((entry) => entry.head === undefined)] : range,
				),
				context,
			),
			...(live?.run ? { run: { inputs: live.run.inputs } } : {}),
			...(live?.generation ? { generation: live.generation } : {}),
			tools: live?.tools ?? [],
			compactions: live?.compactions ?? [],
			inbox: (inbox?.items ?? []).map(({ id, mode }) => ({ id, mode })),
			agent: agent ?? {},
			usage: usage ?? { models: {}, tools: {} },
		};
		const audit = await session.snapshot(GitHubActionsDoc, context);
		const events: AgentEvent[] = [
			snapshot,
			await queueUpdateForDisplay(
				inbox ?? null,
				(id) => storage.submission(id, context),
				undefined,
				Date.now(),
				(await session.snapshot(HeldInputsDoc, id, context)) ?? null,
			),
			{ type: "github_actions_update", actions: [...(audit?.actions ?? [])] },
		];
		if (!live?.run && attention?.completion) {
			const { outcome, outcomeAt, outcomeReason } = normalizeCompletion(attention.completion);
			return {
				events,
				completion: { outcome, outcomeAt, ...(outcomeReason === undefined ? {} : { outcomeReason }) },
			};
		}
		return { events };
	} finally {
		await session.close(context);
	}
}

/**
 * One read of a pi-extensions subagent conversation from its private `runs.sqlite`.
 * `full` reads replace the transcript with one snapshot event; incremental reads only append entries.
 */
export interface SubagentTranscriptRead {
	full: boolean;
	/** A snapshot event when full (none before the child has storage), otherwise `entry_appended` events. */
	events: AgentEvent[];
	/** Newest entry ID included so far. Pass it back as `after` for the next incremental read. */
	cursor?: number;
}

/**
 * Read-only, never a writer: each call opens and closes its own short read transaction, so a long-lived
 * watcher cannot pin the child's WAL. With `after`, returns only newer entries, unless compaction
 * moved the head marker, which needs a full replacement.
 */
export async function readSubagentTranscript(
	directory: string,
	conversationId: string,
	after?: number,
): Promise<SubagentTranscriptRead> {
	const id = Number(conversationId);
	if (!Number.isSafeInteger(id) || id < 0) throw new Error(`Invalid subagent conversation: ${conversationId}`);
	if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error(`Invalid cursor: ${after}`);
	const storage = await openSessionReader(directory, "runs.sqlite");
	if (!storage) return { full: true, events: [] };
	if (after !== undefined) {
		let full = false;
		const entries: EntryRecord[] = [];
		try {
			const head = await storage.findLatestHeadMarker(id as ConversationId, undefined, context);
			full = head !== undefined && Number(head.id) > after;
			let cursor: Cursor | undefined;
			while (!full) {
				const page = await storage.scanEntries(
					{ conversationId: id as ConversationId, minEntryId: (after + 1) as EntryRecord["id"] },
					256,
					cursor,
					context,
				);
				entries.push(...page.items);
				cursor = page.next;
				if (cursor === undefined) break;
			}
		} finally {
			await storage.close(context);
		}
		entries.sort((a, b) => Number(a.id) - Number(b.id));
		if (!full && !entries.some((entry) => entry.head !== undefined))
			return {
				full: false,
				events: entries.map((entry) => ({ type: "entry_appended", entry })),
				cursor: entries.length ? Number(entries.at(-1)!.id) : after,
			};
		return readSubagentTranscript(directory, conversationId);
	}
	const view = await conversationView(storage, id as ConversationId);
	// Only the transcript: the child's inbox belongs to its supervisor, not to Pilot's queue editor.
	const events = view.events.filter((event) => event.type === "snapshot");
	const snapshot = events[0];
	const ids = snapshot?.type === "snapshot" ? snapshot.entries.map((entry) => Number(entry.id)) : [];
	return { full: true, events, ...(ids.length ? { cursor: Math.max(...ids) } : {}) };
}

/** One page of retained entries from before the active transcript (hidden by compaction or reset). */
export interface EarlierEntriesRead {
	/** Oldest first. */
	entries: EntryRecord[];
	/** True when older entries may remain; pass the oldest returned ID as the next `before`. */
	more: boolean;
}

/** Stop a page early once its JSON passes this size, so a few huge tool results cannot build an unbounded reply. */
export const EARLIER_ENTRIES_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Read-only page of the session's entries with IDs below `before`, newest first from storage and returned oldest
 * first. Includes older compaction and reset markers. At least one entry is returned when any exists.
 */
export async function readEarlierEntries(
	directory: string,
	before: number,
	limit: number,
): Promise<EarlierEntriesRead> {
	if (!Number.isSafeInteger(before) || before < 0) throw new Error(`Invalid cursor: ${before}`);
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid limit: ${limit}`);
	if (before <= 1) return { entries: [], more: false };
	const storage = await openSessionReader(directory);
	if (!storage) return { entries: [], more: false };
	const entries: EntryRecord[] = [];
	let bytes = 0;
	let more = false;
	try {
		const conversationId = await activeConversation(storage, context);
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanEntries(
				{ conversationId, maxEntryId: (before - 1) as EntryRecord["id"] },
				64,
				cursor,
				context,
			);
			for (const entry of page.items) {
				// The first entry is always included, whatever its size.
				if (entries.length >= limit || bytes >= EARLIER_ENTRIES_MAX_BYTES) {
					more = true;
					break;
				}
				entries.push(entry);
				bytes += Buffer.byteLength(JSON.stringify(entry));
			}
			cursor = page.next;
		} while (cursor !== undefined && !more);
		entries.splice(
			0,
			entries.length,
			...(await chatEventEntries(
				createSession(storage),
				await new InputOrigins(storage, await lineage(storage, conversationId, context), context).entries(entries),
				context,
			)),
		);
	} finally {
		await storage.close(context);
	}
	entries.sort((a, b) => Number(a.id) - Number(b.id));
	return { entries, more };
}

export async function readSessionSnapshot(
	directory: string,
	cwd: string,
	includeTodos = true,
): Promise<PersistedSessionView> {
	const storage = await openSessionReader(directory);
	let events: AgentEvent[];
	let completion: SessionCompletion | undefined;
	if (!storage) {
		events = [
			{
				type: "snapshot",
				entries: [],
				tools: [],
				compactions: [],
				inbox: [],
				agent: {},
				usage: { models: {}, tools: {} },
			},
			queueUpdate(null),
			{ type: "github_actions_update", actions: [] },
		];
	} else {
		const view = await conversationView(storage, await activeConversation(storage, context));
		events = view.events;
		completion = view.completion;
	}
	// Ask must not display live checkout extension TODOs, especially for pinned branch snapshots.
	if (includeTodos) {
		// Read display-only extension files, never load or execute extension code.
		const todos = new TodosWatch(todosDirectory(cwd));
		await todos.refresh();
		events.push(todos.current);
	} else {
		events.push({ type: "todos_update", items: [] });
	}
	return { events, ...(completion ? { completion } : {}) };
}
