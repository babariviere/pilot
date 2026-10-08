/** Cold transcript viewing. Deliberately imports neither the SDK nor the Harness. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	createSession,
	type Cursor,
	type EntryRecord,
	InboxDoc,
	LiveDoc,
	ROOT_CONVERSATION_ID,
	UsageDoc,
} from "@earendil-works/pi-durable";
import type { AgentEvent, SessionCompletion } from "@pilot/protocol";
import { AttentionDoc } from "./attention.ts";
import { queueUpdate } from "./queue.ts";
import { openSessionReader } from "./storage.ts";
import { TodosWatch, todosDirectory } from "./todos.ts";

export interface PersistedSessionView {
	events: AgentEvent[];
	/** Only the persisted version, never a synthesized completion or a new outcome timestamp. */
	completion?: SessionCompletion;
}

export async function readSessionSnapshot(directory: string, cwd: string): Promise<PersistedSessionView> {
	const storage = await openSessionReader(directory);
	const context = BACKGROUND_CONTEXT;
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
		const session = createSession(storage);
		try {
			const id = ROOT_CONVERSATION_ID;
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
			events = [snapshot, queueUpdate(inbox ?? null)];
			if (!live?.run && attention?.completion) {
				const { outcome, outcomeAt, outcomeReason } = attention.completion;
				completion = { outcome, outcomeAt, ...(outcomeReason === undefined ? {} : { outcomeReason }) };
			}
		} finally {
			await session.close(context);
		}
	}
	// Read display-only extension files, never load or execute extension code.
	const todos = new TodosWatch(todosDirectory(cwd));
	await todos.refresh();
	events.push(todos.current);
	return { events, ...(completion ? { completion } : {}) };
}
