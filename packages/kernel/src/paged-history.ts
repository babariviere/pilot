/** Bounded transcript storage reads. Agent context and legacy snapshots are unchanged. */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import type { SessionHistoryPage, TranscriptContext, TranscriptHistory } from "@pilot/protocol";

export const RECENT_ENTRIES = 60;
const PAGE_BYTES = 256 * 1024;

/** Current question metadata is independent of the reader's loaded history pages. */
export function questionBoundary(entries: readonly EntryRecord[]): EntryRecord | null | undefined {
	let latest = -1;
	let boundary: EntryRecord | null | undefined;
	for (const entry of entries) {
		if (Number(entry.id) <= latest) continue;
		if (entry.kind === "pilot.question") {
			latest = Number(entry.id);
			boundary = entry;
		} else if (entry.kind !== "pi.compaction" && entry.model?.some((m) => m.role === "user")) {
			latest = Number(entry.id);
			boundary = null;
		}
	}
	return boundary;
}

export async function readQuestionBoundary(
	storage: Storage,
	view: TranscriptContext,
	context: Context,
): Promise<EntryRecord | null> {
	let before = view.tail + 1;
	for (;;) {
		const page = await storage.scanEntries(
			{
				conversationId: view.conversationId as ConversationId,
				maxEntryId: (before - 1) as EntryRecord["id"],
				...(view.head ? { minEntryId: view.head.start as EntryRecord["id"] } : {}),
			},
			64,
			undefined,
			context,
		);
		const question = questionBoundary(
			page.items.filter((entry) => !view.head || entry.head === undefined || Number(entry.id) === view.head.id),
		);
		if (question !== undefined) return question;
		if (!page.next) return null;
		before = Number(page.items.at(-1)!.id);
	}
}

/** Newest entries, stopping before hydrating the rest of the range. Always admits one oversized entry. */
async function scan(
	storage: Storage,
	view: TranscriptContext,
	before: number,
	limit: number,
	context: Context,
	activeOnly = false,
) {
	const entries: EntryRecord[] = [];
	let next = Math.min(before, view.tail + 1);
	let bytes = 0;
	for (;;) {
		const page = await storage.scanEntries(
			{
				conversationId: view.conversationId as ConversationId,
				maxEntryId: (next - 1) as EntryRecord["id"],
				...(activeOnly && view.head ? { minEntryId: view.head.start as EntryRecord["id"] } : {}),
			},
			Math.min(limit + 1, 64),
			undefined,
			context,
		);
		for (const entry of page.items) {
			const id = Number(entry.id);
			// The initial snapshot includes the current head marker separately, as legacy snapshots do.
			if (view.head && id >= view.head.start && entry.head !== undefined) {
				next = id;
				continue;
			}
			if (entries.length >= limit || (entries.length > 0 && bytes >= PAGE_BYTES))
				return { entries, nextBefore: next };
			entries.push(entry);
			bytes += Buffer.byteLength(JSON.stringify(entry));
			next = id;
		}
		if (!page.next) return { entries, nextBefore: undefined };
	}
}

export async function readRecentEntries(
	storage: Storage,
	id: ConversationId,
	context: Context,
): Promise<{ entries: EntryRecord[]; history: TranscriptHistory }> {
	if (!(await storage.conversation(id, context))) throw new Error("Transcript conversation is unavailable");
	const head = await storage.findLatestHeadMarker(id, undefined, context);
	const newest = (await storage.scanEntries({ conversationId: id }, 1, undefined, context)).items[0];
	const view: TranscriptContext = {
		conversationId: Number(id),
		tail: Number(newest?.id ?? 0),
		...(head ? { head: { id: Number(head.id), start: Number(head.head) } } : {}),
	};
	const page = await scan(storage, view, view.tail + 1, RECENT_ENTRIES, context, true);
	let before = page.nextBefore;
	if (before === undefined && head && Number(head.head) > 1) {
		const older = await storage.scanEntries(
			{ conversationId: id, maxEntryId: (Number(head.head) - 1) as EntryRecord["id"] },
			1,
			undefined,
			context,
		);
		if (older.items.length) before = Number(head.head);
	}
	return {
		entries: [...(head ? [head] : []), ...page.entries.reverse()],
		history: { context: view, more: before !== undefined, ...(before === undefined ? {} : { before }) },
	};
}

/** The caller pins this immutable conversation/range, even after an attempt or compaction changes. */
export async function readTranscriptPage(
	storage: Storage,
	view: TranscriptContext,
	before: number,
	limit: number,
	context: Context,
): Promise<SessionHistoryPage> {
	const page = await scan(storage, view, before, limit, context);
	return {
		entries: page.entries.reverse(),
		context: view,
		before,
		more: page.nextBefore !== undefined,
		...(page.nextBefore === undefined ? {} : { nextBefore: page.nextBefore }),
	};
}

/** Live SDK views are already hydrated for execution/status. Trim before decoration and IPC, not after serialization. */
export function recentSnapshot(
	entries: readonly EntryRecord[],
	conversationId: ConversationId,
	questionPending?: boolean,
): { entries: EntryRecord[]; history: TranscriptHistory } {
	const head = entries.find((e) => e.head !== undefined);
	const ordinary = entries.filter((e) => e !== head);
	let start = ordinary.length;
	let bytes = 0;
	while (start > 0 && ordinary.length - start < RECENT_ENTRIES) {
		if (start < ordinary.length && bytes >= PAGE_BYTES) break;
		bytes += Buffer.byteLength(JSON.stringify(ordinary[--start]));
	}
	const recent = ordinary.slice(start);
	const before =
		ordinary.length > recent.length
			? Number(recent[0]!.id)
			: head && Number(head.head) > 1
				? Number(head.head)
				: undefined;
	return {
		entries: [...(head ? [head] : []), ...recent],
		history: {
			question: questionPending === false ? null : (questionBoundary(entries) ?? null),
			context: {
				conversationId: Number(conversationId),
				tail: entries.reduce((tail, e) => Math.max(tail, Number(e.id)), 0),
				...(head ? { head: { id: Number(head.id), start: Number(head.head) } } : {}),
			},
			more: before !== undefined,
			...(before === undefined ? {} : { before }),
		},
	};
}
