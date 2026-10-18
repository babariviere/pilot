/** Disabled host capture seam. Runs only in a worker, never opens a Harness or an author writer. */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import type { ConversationRecord, EntryDraft, EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { inputOrigin } from "./input-origin.ts";

export const REVIEW_HISTORY_LIMITS = Object.freeze({
	bytes: 20 * 1024 * 1024,
	recordBytes: 8 * 1024 * 1024,
	readBytes: 50 * 1024,
	pageRecords: 64,
	records: 40_000,
	reads: 41_024,
	lineage: 64,
	durationMs: 60_000,
});
export interface ReviewHistoryPin {
	attemptId: number;
	/** Inclusive committed entry, or zero for an explicitly empty checkpoint. Never the current head. */
	boundary: number;
}
export interface HistoryDisclosure {
	code: string;
	count: number;
	/** Bounded examples, not a complete inventory of missing entries. */
	entryIds: number[];
}
export interface ReviewHistoryExport {
	pin: ReviewHistoryPin;
	revision?: number;
	status: "captured" | "unavailable";
	conversations: ConversationRecord[];
	entries: number;
	/** UTF-8 NDJSON. Records are immutable storage records, not the active model context. */
	chunks: Uint8Array[];
	disclosures: HistoryDisclosure[];
	bytes: number;
	rawBytes: number;
	records: number;
	reads: number;
}

/** Future trusted admission adapters can persist this alongside placement. Not wired to production input. */
export function originalInputEvidence(requestId: string, originalInput: string, preparedInput: string): EntryDraft {
	if (
		!requestId ||
		Buffer.byteLength(requestId) > 1024 ||
		Buffer.byteLength(originalInput) > 24 * 1024 ||
		Buffer.byteLength(preparedInput) > REVIEW_HISTORY_LIMITS.recordBytes
	)
		throw new Error("Original input provenance exceeds bounds");
	return {
		kind: "pilot.original-input",
		data: {
			version: 1,
			requestId,
			receivedAs: "host_input",
			originalInput,
			preparedSha256: createHash("sha256").update(preparedInput).digest("hex"),
			// Even an exact original input is evidence, never structured approval.
			authorization: "not_recorded",
		},
	};
}

type Row = { id: number; bytes: number };
const validId = (id: number) => Number.isSafeInteger(id) && id >= 1;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Schema-qualified raw export: SDK scans hydrate entire JSON rows before a caller can impose byte bounds.
 * Only the default schema v1 is supported. Queries mirror scanEntries' fork-segment rules, not context().
 * Each payload read is <=50 KiB, each row <=8 MiB, total <=20 MiB; work and ancestry are also capped.
 */
export function exportCommittedHistory(
	directory: string,
	pin: ReviewHistoryPin,
	budget: { bytes?: number; records?: number; reads?: number; durationMs?: number } = {},
): ReviewHistoryExport {
	if (isMainThread) throw new Error("History export requires a worker");
	if (!validId(pin.attemptId) || !Number.isSafeInteger(pin.boundary) || pin.boundary < 0)
		throw new Error("Invalid committed history pin");
	const limits = { ...REVIEW_HISTORY_LIMITS, ...budget };
	for (const key of ["bytes", "records", "reads", "durationMs"] as const)
		if (!validId(limits[key]) || limits[key] > REVIEW_HISTORY_LIMITS[key]) throw new Error("Invalid history budget");
	const result: ReviewHistoryExport = {
		pin,
		status: "unavailable",
		conversations: [],
		entries: 0,
		chunks: [],
		disclosures: [],
		bytes: 0,
		rawBytes: 0,
		records: 0,
		reads: 0,
	};
	const disclose = (code: string, id?: number) => {
		let item = result.disclosures.find((item) => item.code === code);
		if (!item) {
			item = { code, count: 0, entryIds: [] };
			result.disclosures.push(item);
		}
		item.count++;
		if (id !== undefined && item.entryIds.length < 16) item.entryIds.push(id);
	};
	const deadline = performance.now() + limits.durationMs;
	const check = () => {
		if (++result.reads > limits.reads || performance.now() >= deadline) throw new Error("History work limit");
	};
	let db: DatabaseSync;
	try {
		const file = join(realpathSync(directory), "harness.sqlite");
		const before = lstatSync(file);
		if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("Unsafe history file");
		db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
		const after = lstatSync(file);
		if (after.dev !== before.dev || after.ino !== before.ino) {
			db.close();
			throw new Error("History file changed");
		}
	} catch {
		disclose("history_unavailable");
		return result;
	}
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	const flush = () => {
		if (pendingBytes) result.chunks.push(Buffer.concat(pending, pendingBytes));
		pending = [];
		pendingBytes = 0;
	};
	const emit = (type: string, json: string) => {
		const bytes = Buffer.from(`{"type":"${type}","record":${json}}\n`);
		if (bytes.length > limits.recordBytes || result.bytes + bytes.length > limits.bytes) {
			disclose("byte_limit");
			return false;
		}
		if (pendingBytes + bytes.length > 1024 * 1024) flush();
		pending.push(bytes);
		pendingBytes += bytes.length;
		result.bytes += bytes.length;
		return true;
	};
	// Fixed table names only, never source-provided SQL identifiers.
	const raw = (table: "entries" | "submissions" | "conversations", row: Row): string | undefined => {
		if (row.bytes > limits.recordBytes || row.bytes + result.rawBytes + 64 > limits.bytes) {
			disclose("byte_limit", row.id);
			return;
		}
		result.rawBytes += row.bytes;
		const parts: Buffer[] = [];
		for (let offset = 0; offset < row.bytes; offset += limits.readBytes) {
			check();
			const part = db
				.prepare(`SELECT substr(CAST(record AS BLOB), ?, ?) AS part FROM ${table} WHERE id = ?`)
				.get(offset + 1, Math.min(limits.readBytes, row.bytes - offset), row.id)?.part;
			if (!(part instanceof Uint8Array)) throw new Error("History row unavailable");
			parts.push(Buffer.from(part));
		}
		const bytes = Buffer.concat(parts);
		if (bytes.length !== row.bytes) throw new Error("History row unavailable");
		return utf8.decode(bytes);
	};
	try {
		db.exec("PRAGMA query_only = ON; BEGIN");
		// Deliberately refuse a future dependency/schema until this export seam is requalified.
		if (
			CURRENT_SQLITE_SCHEMA_VERSION !== 1 ||
			db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()?.version !== 1
		) {
			disclose("unsupported_storage_schema");
			return result;
		}
		result.revision = Number(
			db.prepare("SELECT next_seq - 1 AS revision FROM durable_metadata WHERE singleton = 1").get()?.revision,
		);
		if (!Number.isSafeInteger(result.revision)) throw new Error("History revision unavailable");
		const segments: { conversationId: number; upper: number }[] = [];
		let next = pin.attemptId;
		let upper = pin.boundary;
		while (true) {
			check();
			if (segments.length >= limits.lineage || segments.some((segment) => segment.conversationId === next))
				throw new Error("History lineage limit");
			const row = db.prepare("SELECT id, octet_length(record) AS bytes FROM conversations WHERE id = ?").get(next) as
				| Row
				| undefined;
			if (!row) {
				disclose("ancestor_or_attempt_unavailable");
				break;
			}
			if (row.bytes > 4096) throw new Error("History conversation limit");
			const json = raw("conversations", row);
			if (!json) break;
			const record = JSON.parse(json) as ConversationRecord;
			if (record.id !== next) throw new Error("Invalid history conversation");
			const conversation: ConversationRecord = {
				id: record.id,
				...(record.parent
					? { parent: { conversationId: record.parent.conversationId, at: record.parent.at } }
					: {}),
				...(record.owner
					? { owner: { conversationId: record.owner.conversationId, taskId: record.owner.taskId } }
					: {}),
			};
			result.conversations.push(conversation);
			segments.push({ conversationId: next, upper });
			if (!record.parent) break;
			disclose("rewind_or_fork");
			if (!validId(record.parent.conversationId) || !validId(record.parent.at))
				throw new Error("Invalid history parent");
			upper = Math.min(upper, record.parent.at);
			next = record.parent.conversationId;
		}
		if (!segments.length) return result;
		// A missing/moved boundary is never silently replaced with the newest entry or another attempt.
		if (
			pin.boundary !== 0 &&
			!segments.some(
				(segment) =>
					pin.boundary <= segment.upper &&
					db
						.prepare("SELECT id FROM entries WHERE conversation_id = ? AND id = ?")
						.get(segment.conversationId, pin.boundary),
			)
		) {
			disclose("boundary_unavailable");
			return result;
		}
		result.status = "captured";
		disclose("retained_history_only");
		disclose("streaming_and_queued_input_excluded");
		const users = new Map<number, { digest: string; original: boolean; submission: boolean }>();
		const originals = new Map<string, { id: number; digest: string; json: string }>();
		const conflictingOriginals = new Set<string>();
		let stopped = false;
		for (const segment of segments.toReversed()) {
			let after = 0;
			while (!stopped) {
				check();
				const rows = db
					.prepare(
						"SELECT id, octet_length(record) AS bytes FROM entries WHERE conversation_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?",
					)
					.all(segment.conversationId, after, segment.upper, limits.pageRecords) as Row[];
				if (!rows.length) break;
				for (const row of rows) {
					if (++result.records > limits.records) {
						disclose("record_limit");
						stopped = true;
						break;
					}
					after = row.id;
					const json = raw("entries", row);
					if (!json) continue;
					const entry = JSON.parse(json) as EntryRecord;
					if (
						entry.id !== row.id ||
						entry.conversationId !== segment.conversationId ||
						typeof entry.kind !== "string"
					)
						throw new Error("Invalid history entry");
					if (entry.kind !== "pilot.original-input") {
						if (!emit("entry", json)) {
							stopped = true;
							break;
						}
						result.entries++;
					}
					if (entry.kind === "pi.compaction") {
						disclose("compaction", entry.id);
						disclose("pre_compaction_completeness_unverifiable", entry.id);
					} else if (entry.head !== undefined) disclose("context_reset_or_head_change", entry.id);
					if (entry.edits?.length) disclose("context_edits_originals_retained", entry.id);
					if (entry.kind === "pilot.artifact") disclose("artifact_content_not_acquired", entry.id);
					if (entry.kind === "pi.user") {
						const text = (entry.model ?? [])
							.flatMap((message) =>
								message.role !== "user"
									? []
									: typeof message.content === "string"
										? [message.content]
										: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
							)
							.join("\n");
						users.set(entry.id, {
							digest: createHash("sha256").update(text).digest("hex"),
							original: false,
							submission: false,
						});
					}
					if (entry.kind === "pilot.original-input") {
						const data = entry.data as
							| { requestId?: string; preparedSha256?: string; originalInput?: string; version?: number }
							| undefined;
						if (
							data?.version === 1 &&
							typeof data.requestId === "string" &&
							typeof data.originalInput === "string" &&
							typeof data.preparedSha256 === "string"
						) {
							if (originals.has(data.requestId) || conflictingOriginals.has(data.requestId)) {
								originals.delete(data.requestId);
								conflictingOriginals.add(data.requestId);
								disclose("conflicting_original_input", entry.id);
							} else originals.set(data.requestId, { id: entry.id, digest: data.preparedSha256, json });
						}
					}
				}
			}
		}
		// Submissions are mutable receipts read at this same SQLite revision. Never export queued entries or inbox content.
		for (const segment of segments) {
			let after = 0;
			while (!stopped && users.size) {
				check();
				const rows = db
					.prepare(
						"SELECT id, octet_length(record) AS bytes FROM submissions WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?",
					)
					.all(segment.conversationId, after, limits.pageRecords) as Row[];
				if (!rows.length) break;
				for (const row of rows) {
					if (++result.records > limits.records) {
						disclose("record_limit");
						stopped = true;
						break;
					}
					after = row.id;
					const json = raw("submissions", row);
					if (!json) continue;
					const submission = JSON.parse(json) as SubmissionRecord;
					if (submission.status === "queued" || submission.type !== "input" || submission.entry === undefined)
						continue;
					const user = users.get(submission.entry);
					if (!user) continue;
					user.submission = true;
					const original = submission.requestId ? originals.get(submission.requestId) : undefined;
					const matched = original?.digest === user.digest;
					if (matched && !emit("original_input", original!.json)) {
						stopped = true;
						break;
					}
					user.original ||= matched;
					if (
						!emit(
							"submission_provenance",
							JSON.stringify({
								submission,
								receiptBasis: "capture_revision_not_historical_checkpoint",
								origin: {
									basis: "legacy_request_id_hint",
									hint: inputOrigin(submission.requestId) ?? "unknown",
									authorization: "not_recorded",
								},
								originalInput: matched
									? { basis: "recorded_not_authenticated", entryId: original!.id }
									: { basis: "unavailable" },
							}),
						)
					) {
						stopped = true;
						break;
					}
					disclose("legacy_origin", submission.entry);
				}
			}
		}
		if (!users.size) disclose("original_request_unavailable");
		for (const [id, user] of users) {
			if (!user.original) disclose("missing_original_input", id);
			if (!user.submission) disclose("submission_provenance_unavailable", id);
		}
		// Tool records may carry child references, but never authorize following them into another store.
		disclose("child_history_not_acquired");
		disclose("authorization_not_inferred");
	} catch {
		// Never echo SQLite errors, paths or source text into general logs.
		disclose("history_unavailable_or_work_limit");
	} finally {
		flush();
		try {
			db.exec("ROLLBACK");
		} finally {
			db.close();
		}
	}
	return result;
}
