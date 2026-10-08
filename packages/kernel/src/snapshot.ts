/** Cold transcript viewing. Deliberately imports neither the SDK nor the Harness. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type ConversationId,
	createSession,
	type Cursor,
	type EntryRecord,
	InboxDoc,
	LiveDoc,
	ROOT_CONVERSATION_ID,
	type Storage,
	UsageDoc,
} from "@earendil-works/pi-durable";
import type { AgentEvent, SessionCompletion } from "@pilot/protocol";
import { AttentionDoc, normalizeCompletion } from "./attention.ts";
import { queueUpdate } from "./queue.ts";
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
			entries: head ? [head, ...range.filter((entry) => entry.head === undefined)] : range,
			...(live?.run ? { run: { inputs: live.run.inputs } } : {}),
			...(live?.generation ? { generation: live.generation } : {}),
			tools: live?.tools ?? [],
			compactions: live?.compactions ?? [],
			inbox: (inbox?.items ?? []).map(({ id, mode }) => ({ id, mode })),
			agent: agent ?? {},
			usage: usage ?? { models: {}, tools: {} },
		};
		const events = [snapshot, queueUpdate(inbox ?? null)];
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
 * Read-only snapshot of a pi-extensions subagent conversation from its private `runs.sqlite`.
 * Empty before the child has created its storage.
 */
export async function readSubagentSnapshot(directory: string, conversationId: string): Promise<AgentEvent[]> {
	const id = Number(conversationId);
	if (!Number.isSafeInteger(id) || id < 0) throw new Error(`Invalid subagent conversation: ${conversationId}`);
	const storage = await openSessionReader(directory, "runs.sqlite");
	if (!storage) return [];
	const view = await conversationView(storage, id as ConversationId);
	// Only the transcript: the child's inbox belongs to its supervisor, not to Pilot's queue editor.
	return view.events.filter((event) => event.type === "snapshot");
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
		];
	} else {
		const view = await conversationView(storage, ROOT_CONVERSATION_ID);
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
