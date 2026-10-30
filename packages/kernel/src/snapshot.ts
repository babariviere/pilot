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
import type {
	AgentEvent,
	DiagnosticHistoryEntry,
	DiagnosticHistoryPage,
	DiagnosticTargetReference,
	SessionCompletion,
	TranscriptContext,
} from "@pilot/protocol";
import { activeConversation, lineage } from "./attempts.ts";
import { AttentionDoc, normalizeCompletion } from "./attention.ts";
import { chatEventEntries } from "./chat-events.ts";
import { GitHubActionsDoc } from "./github-actions.ts";
import { HeldInputsDoc } from "./held-inputs.ts";
import { InputOrigins } from "./input-origin.ts";
import { readQuestionBoundary, readRecentEntries, readTranscriptPage } from "./paged-history.ts";
import { queueUpdate, queueUpdateForDisplay } from "./queue.ts";
import { openSessionReader } from "./storage.ts";
import { TodoProgressDoc, todosUpdate } from "./todos.ts";

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
	includeTodos = false,
	recent = false,
): Promise<{ events: AgentEvent[]; completion?: SessionCompletion }> {
	const session = createSession(storage);
	try {
		// Match the durable structural view: newest head marker first, then all retained
		// non-head entries. Compaction/reset history is not the active transcript.
		const head = recent ? undefined : await storage.findLatestHeadMarker(id, undefined, context);
		const bounded = recent ? await readRecentEntries(storage, id, context) : undefined;
		const range: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		while (!bounded) {
			const page = await storage.scanEntries(
				{ conversationId: id, ...(head ? { minEntryId: head.head } : {}) },
				256,
				cursor,
				context,
			);
			range.push(...page.items);
			cursor = page.next;
			if (cursor === undefined) break;
		}
		range.reverse();
		const [agent, live, inbox, usage, attention] = await Promise.all([
			session.snapshot(AgentDoc, id, context),
			session.snapshot(LiveDoc, id, context),
			session.snapshot(InboxDoc, id, context),
			session.snapshot(UsageDoc, id, context),
			session.snapshot(AttentionDoc, id, context),
		]);
		if (bounded) {
			const held = await session.snapshot(HeldInputsDoc, id, context);
			bounded.history.question =
				held?.questionPending === false
					? null
					: await readQuestionBoundary(storage, bounded.history.context, context);
		}
		const snapshot: AgentEvent = {
			type: "snapshot",
			...(bounded ? { history: bounded.history } : {}),
			entries: await chatEventEntries(
				session,
				await new InputOrigins(storage, await lineage(storage, id, context), context).entries(
					bounded?.entries ?? (head ? [head, ...range.filter((entry) => entry.head === undefined)] : range),
				),
				context,
			),
			...(live?.run ? { run: { inputs: live.run.inputs } } : {}),
			...(live?.generation ? { generation: live.generation } : {}),
			tools: live?.tools ?? [],
			nestedTools: live?.nestedTools ?? [],
			compactions: live?.compactions ?? [],
			...(live?.compactionFailure ? { compactionFailure: live.compactionFailure } : {}),
			inbox: (inbox?.items ?? []).map(({ id, mode }) => ({ id, mode })),
			agent: agent ?? {},
			usage: usage ?? { models: {}, tools: {} },
		};
		const audit = await session.snapshot(GitHubActionsDoc, context);
		const todos = includeTodos ? await session.snapshot(TodoProgressDoc, context) : undefined;
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
			...(includeTodos ? [todosUpdate(todos)] : []),
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

export const DIAGNOSTIC_HISTORY_MAX_ENTRIES = 20;
export const DIAGNOSTIC_HISTORY_MAX_BYTES = 64 * 1024;
export const DIAGNOSTIC_HISTORY_ENTRY_MAX_BYTES = 8 * 1024;
export const DIAGNOSTIC_HISTORY_MAX_SCANNED_ENTRIES = 200;
const DIAGNOSTIC_HISTORY_KINDS = new Set<DiagnosticHistoryEntry["kind"]>(["pi.user", "pi.assistant", "pi.tool-result"]);

function isDiagnosticHistoryKind(kind: string): kind is DiagnosticHistoryEntry["kind"] {
	return DIAGNOSTIC_HISTORY_KINDS.has(kind as DiagnosticHistoryEntry["kind"]);
}

/**
 * Read-only page of the session's entries with IDs below `before`, newest first from storage and returned oldest
 * first. Includes older compaction and reset markers. At least one entry is returned when any exists.
 */
export async function readEarlierEntries(
	directory: string,
	before: number,
	limit: number,
	view?: TranscriptContext,
): Promise<EarlierEntriesRead & Partial<import("@pilot/protocol").SessionHistoryPage>> {
	if (!Number.isSafeInteger(before) || before < 0) throw new Error(`Invalid cursor: ${before}`);
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid limit: ${limit}`);
	if (before <= 1 && !view) return { entries: [], more: false };
	const storage = await openSessionReader(directory);
	if (!storage) {
		if (view) throw new Error("Captured transcript storage is unavailable");
		return { entries: [], more: false };
	}
	if (view) {
		try {
			if (
				!(await storage.conversation(view.conversationId as ConversationId, context)) ||
				(view.tail > 0 &&
					!(await storage.entry(view.conversationId as ConversationId, view.tail as EntryRecord["id"], context)))
			)
				throw new Error("Captured transcript range is unavailable");
			if (before <= 1) return { entries: [], more: false, context: view, before };
			const page = await readTranscriptPage(storage, view, before, limit, context);
			const session = createSession(storage);
			page.entries = await chatEventEntries(
				session,
				await new InputOrigins(
					storage,
					await lineage(storage, view.conversationId as ConversationId, context),
					context,
				).entries(page.entries),
				context,
			);
			return page;
		} finally {
			await storage.close(context);
		}
	}
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

function utf8Prefix(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function serializedDiagnosticEntry(entry: EntryRecord): string {
	return JSON.stringify(entry, (key, value) => {
		if (
			/^(?:auth|authentication)$|key$|authorization|cookie|token|secret|password|passwd|credential|signature/i.test(
				key,
			)
		)
			return "[REDACTED]";
		if (
			typeof value === "string" &&
			(/-----\s*(?:BEGIN|END)[^\n]*(?:PRIVATE KEY|OPENSSH|PGP)/i.test(value) ||
				/\b(?:Bearer|Basic)\s+\S+|:\/\/[^\s/@]+:[^\s/@]+@|[?&](?:sig|signature|key|auth)=|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]+/i.test(
					value,
				))
		)
			return "[REDACTED secret-bearing text]";
		if (!value || typeof value !== "object" || Array.isArray(value)) return value;
		const type = (value as { type?: unknown }).type;
		if (type === "thinking" || type === "redacted_thinking") return { type, omitted: "private_reasoning" };
		return type === "image" ||
			type === "audio" ||
			type === "file" ||
			type === "document" ||
			type === "resource" ||
			type === "resource_link"
			? { type, omitted: "attachment" }
			: value;
	});
}

function diagnosticHistoryUnavailable(
	target: DiagnosticTargetReference,
	limit: number,
	before: number | undefined,
	availability: "missing" | "unavailable",
	reason: "storage_missing" | "read_failed",
): DiagnosticHistoryPage {
	return {
		schemaVersion: 1,
		target,
		collectedAt: new Date().toISOString(),
		source: { availability, freshness: "unavailable", reason },
		entries: [],
		pagination: {
			...(before === undefined ? {} : { before }),
			more: false,
			returned: 0,
			limit,
			scannedEntries: 0,
			maxScannedEntries: DIAGNOSTIC_HISTORY_MAX_SCANNED_ENTRIES,
			encodedBytes: 0,
			maxBytes: DIAGNOSTIC_HISTORY_MAX_BYTES,
			perEntryMaxBytes: DIAGNOSTIC_HISTORY_ENTRY_MAX_BYTES,
			truncatedEntries: 0,
		},
	};
}

/**
 * Read a bounded newest-first storage page for one host-authorized diagnostic target. The response is chronological,
 * each entry is byte-truncated explicitly, and callers continue toward older entries with `nextBefore`. This opens
 * only a short read transaction and never initializes or wakes the target's kernel.
 */
export async function readDiagnosticHistoryPage(
	directory: string,
	target: DiagnosticTargetReference,
	before: number | undefined,
	limit: number,
): Promise<DiagnosticHistoryPage> {
	if (before !== undefined && (!Number.isSafeInteger(before) || before < 0))
		throw new Error(`Invalid diagnostic history cursor: ${before}`);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > DIAGNOSTIC_HISTORY_MAX_ENTRIES)
		throw new Error(`Invalid diagnostic history limit: ${limit}`);
	let storage: Storage | undefined;
	try {
		storage = await openSessionReader(directory);
	} catch {
		return diagnosticHistoryUnavailable(target, limit, before, "unavailable", "read_failed");
	}
	if (!storage) return diagnosticHistoryUnavailable(target, limit, before, "missing", "storage_missing");
	try {
		const conversationId = await activeConversation(storage, context);
		const entries: DiagnosticHistoryEntry[] = [];
		let encodedBytes = 0;
		let truncatedEntries = 0;
		let scannedEntries = 0;
		let more = false;
		let nextBefore: number | undefined;
		let cursor: Cursor | undefined;
		if ((before ?? Number.MAX_SAFE_INTEGER) > 1) {
			for (;;) {
				const page = await storage.scanEntries(
					{
						conversationId,
						maxEntryId: ((before ?? Number.MAX_SAFE_INTEGER) - 1) as EntryRecord["id"],
					},
					1,
					cursor,
					context,
				);
				const entry = page.items[0];
				if (!entry) break;
				scannedEntries++;
				cursor = page.next;
				if (!isDiagnosticHistoryKind(entry.kind)) {
					if (cursor === undefined) break;
					if (scannedEntries >= DIAGNOSTIC_HISTORY_MAX_SCANNED_ENTRIES) {
						more = true;
						nextBefore = Number(entry.id);
						break;
					}
					continue;
				}
				const serialized = serializedDiagnosticEntry(entry);
				const originalBytes = Buffer.byteLength(serialized);
				const truncated = originalBytes > DIAGNOSTIC_HISTORY_ENTRY_MAX_BYTES;
				const result: DiagnosticHistoryEntry = {
					ref: `diagnostic-history:v1:${target.sessionId}:${entry.id}`,
					entryId: Number(entry.id),
					kind: entry.kind,
					excerpt: utf8Prefix(serialized, DIAGNOSTIC_HISTORY_ENTRY_MAX_BYTES),
					originalBytes,
					truncated,
				};
				const resultBytes = Buffer.byteLength(JSON.stringify(result));
				if (entries.length && encodedBytes + resultBytes > DIAGNOSTIC_HISTORY_MAX_BYTES) {
					more = true;
					nextBefore = entries.at(-1)!.entryId;
					break;
				}
				entries.push(result);
				encodedBytes += resultBytes;
				if (truncated) truncatedEntries++;
				more = cursor !== undefined;
				if (entries.length >= limit) {
					if (more) nextBefore = result.entryId;
					break;
				}
				if (cursor === undefined) break;
				if (scannedEntries >= DIAGNOSTIC_HISTORY_MAX_SCANNED_ENTRIES) {
					nextBefore = result.entryId;
					break;
				}
			}
		}
		entries.reverse();
		return {
			schemaVersion: 1,
			target,
			collectedAt: new Date().toISOString(),
			source: { availability: "available", freshness: "fresh" },
			entries,
			pagination: {
				...(before === undefined ? {} : { before }),
				...(nextBefore === undefined ? {} : { nextBefore }),
				more,
				returned: entries.length,
				limit,
				scannedEntries,
				maxScannedEntries: DIAGNOSTIC_HISTORY_MAX_SCANNED_ENTRIES,
				encodedBytes,
				maxBytes: DIAGNOSTIC_HISTORY_MAX_BYTES,
				perEntryMaxBytes: DIAGNOSTIC_HISTORY_ENTRY_MAX_BYTES,
				truncatedEntries,
			},
		};
	} catch {
		return diagnosticHistoryUnavailable(target, limit, before, "unavailable", "read_failed");
	} finally {
		await storage.close(context).catch(() => undefined);
	}
}

export async function readSessionSnapshot(
	directory: string,
	_cwd: string,
	includeTodos = true,
	recent = false,
): Promise<PersistedSessionView> {
	const storage = await openSessionReader(directory);
	let events: AgentEvent[];
	let completion: SessionCompletion | undefined;
	if (!storage) {
		if (recent) throw new Error("Transcript storage is unavailable");
		events = [
			{
				type: "snapshot",
				entries: [],
				tools: [],
				nestedTools: [],
				compactions: [],
				inbox: [],
				agent: {},
				usage: { models: {}, tools: {} },
			},
			queueUpdate(null),
			{ type: "github_actions_update", actions: [] },
			todosUpdate(undefined),
		];
	} else {
		const view = await conversationView(storage, await activeConversation(storage, context), includeTodos, recent);
		events = view.events;
		completion = view.completion;
	}
	if (!includeTodos && storage) events.push(todosUpdate(undefined));
	return { events, ...(completion ? { completion } : {}) };
}

/** Cheap cold count, independent of transcript size or TODO bodies. No writer lease or migrations. */
export async function readSessionTodoCount(directory: string): Promise<number> {
	const storage = await openSessionReader(directory);
	if (!storage) return 0;
	const session = createSession(storage);
	try {
		return (await session.snapshot(TodoProgressDoc, context))?.openCount ?? 0;
	} finally {
		await session.close(context);
	}
}
