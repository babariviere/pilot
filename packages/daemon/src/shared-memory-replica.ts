/** All methods run in the memory worker, never on pilotd's event loop. */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	MemoryEntry,
	MemoryNode,
	MemoryRecall,
	MemoryView,
	SharedMemoryCheckpointManifest,
	SharedMemoryCheckpointPage,
	SharedMemoryChangePage,
	SharedMemoryCommitOutcome,
	SharedMemoryMutation,
	SharedMemoryProposal,
	SharedMemoryRead,
	SharedMemoryReplicaState,
} from "@pilot/protocol";
import {
	checkMutation,
	digestMemory,
	MEMORY_PAGE_BYTES,
	MEMORY_PAGE_LIMIT,
	memoryId,
	rawMemoryEntry,
	checkMemoryExport,
} from "./shared-memory-common.ts";

type Meta = { sequence: number; complete: number; manifest: string | null; overlayRevision: number };
const MAX_PROPOSALS = 256;
const MAX_STAGING = 8;
function checkManifest(manifest: SharedMemoryCheckpointManifest): void {
	memoryId(manifest.checkpointId);
	if (
		!Number.isSafeInteger(manifest.count) ||
		manifest.count < 0 ||
		manifest.sequence !== manifest.count ||
		!/^[a-f0-9]{64}$/.test(manifest.digest)
	)
		throw new Error("Invalid memory checkpoint manifest");
}
function pageSize(value: unknown): void {
	if (Buffer.byteLength(JSON.stringify(value)) > MEMORY_PAGE_BYTES) throw new Error("Memory page too large");
}
export class SharedMemoryReplica {
	private db!: DatabaseSync;
	private lease: DatabaseSync;
	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.lease = new DatabaseSync(`${path}.owner.sqlite`, { timeout: 0 });
		try {
			this.lease.exec("BEGIN EXCLUSIVE");
		} catch (error) {
			this.lease.close();
			throw error;
		}
		try {
			this.db = new DatabaseSync(path);
			chmodSync(path, 0o600);
			this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
			CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id=1), sequence INTEGER NOT NULL, complete INTEGER NOT NULL, manifest TEXT, overlayRevision INTEGER NOT NULL DEFAULT 0);
			INSERT OR IGNORE INTO meta (id, sequence, complete, manifest) VALUES (1, 0, 0, NULL);
			CREATE TABLE IF NOT EXISTS entries (idx INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS replacements (id TEXT PRIMARY KEY, byIndex INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS staging (id TEXT PRIMARY KEY, manifest TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS pages (manifest TEXT NOT NULL, cursor INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (manifest, cursor));
			CREATE TABLE IF NOT EXISTS proposals (operation TEXT PRIMARY KEY, mutation TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, outcome TEXT);
			CREATE INDEX IF NOT EXISTS proposals_active ON proposals(state) WHERE state!='settled';`);
			if (
				!this.db
					.prepare("PRAGMA table_info(meta)")
					.all()
					.some((column) => column.name === "overlayRevision")
			)
				this.db.exec("ALTER TABLE meta ADD COLUMN overlayRevision INTEGER NOT NULL DEFAULT 0");
			if (Number(this.db.prepare("PRAGMA user_version").get()!.user_version) < 1) {
				this.transaction(() => {
					for (const entry of this.rawEntries())
						for (const id of entry.replaces ?? [])
							this.db.prepare("INSERT OR REPLACE INTO replacements VALUES (?, ?)").run(id, entry.index);
					this.db.exec("PRAGMA user_version=1");
				});
			}
			for (const dir of [dirname(path), dirname(dirname(path))]) {
				const fd = openSync(dir, "r");
				try {
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
			}
		} catch (error) {
			this.db?.close();
			this.lease.close();
			throw error;
		}
	}
	close(): void {
		this.db.close();
		this.lease.close();
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private meta(): Meta {
		return this.db.prepare("SELECT sequence, complete, manifest, overlayRevision FROM meta WHERE id=1").get() as Meta;
	}
	/** Called within the same transaction as each proposal/outcome/visible-overlay transition. */
	private bumpOverlayRevision(): void {
		const changed = this.db
			.prepare(
				"UPDATE meta SET overlayRevision=overlayRevision+1 WHERE id=1 AND overlayRevision>=0 AND overlayRevision<9007199254740991",
			)
			.run();
		if (Number(changed.changes) !== 1) throw new Error("Memory overlay revision exhausted or corrupt");
	}
	state(): SharedMemoryReplicaState {
		const meta = this.meta(),
			counts = this.db
				.prepare(
					"SELECT SUM(state='pending' AND outcome IS NULL) AS pending, SUM(state IN ('conflict','rejected')) AS conflicts FROM proposals WHERE state!='settled'",
				)
				.get()!;
		return {
			sequence: meta.sequence,
			complete: !!meta.complete,
			pendingCount: Number(counts.pending ?? 0),
			conflictCount: Number(counts.conflicts ?? 0),
			overlayRevision: meta.overlayRevision,
		};
	}
	stage(manifest: SharedMemoryCheckpointManifest, page: SharedMemoryCheckpointPage): void {
		checkManifest(manifest);
		pageSize(page);
		if (
			page.checkpointId !== manifest.checkpointId ||
			!Number.isSafeInteger(page.cursor) ||
			page.cursor < 0 ||
			page.cursor > manifest.count ||
			!Array.isArray(page.entries) ||
			page.entries.length > MEMORY_PAGE_LIMIT
		)
			throw new Error("Invalid memory checkpoint page");
		const end = page.cursor + page.entries.length;
		if (
			end > manifest.count ||
			(end < manifest.count ? page.next !== end || !page.entries.length : page.next !== undefined)
		)
			throw new Error("Invalid memory checkpoint page continuation");
		for (let i = 0; i < page.entries.length; i++) {
			const entry = rawMemoryEntry(page.entries[i]!);
			checkMemoryExport(entry.text);
			if (entry.index !== page.cursor + i) throw new Error("Memory checkpoint indices are not contiguous");
		}
		this.transaction(() => {
			const existing = this.db.prepare("SELECT manifest FROM staging WHERE id=?").get(manifest.checkpointId),
				json = JSON.stringify(manifest);
			if (existing && existing.manifest !== json) throw new Error("Memory manifest identity reused");
			if (!existing) {
				if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM staging").get()!.n) >= MAX_STAGING) {
					const oldest = this.db.prepare("SELECT id FROM staging ORDER BY rowid LIMIT 1").get()!.id as string;
					this.db.prepare("DELETE FROM pages WHERE manifest=?").run(oldest);
					this.db.prepare("DELETE FROM staging WHERE id=?").run(oldest);
				}
				this.db.prepare("INSERT INTO staging VALUES (?, ?)").run(manifest.checkpointId, json);
			}
			const previous = this.db
					.prepare("SELECT value FROM pages WHERE manifest=? AND cursor=?")
					.get(manifest.checkpointId, page.cursor),
				value = JSON.stringify({
					checkpointId: page.checkpointId,
					cursor: page.cursor,
					entries: page.entries.map(rawMemoryEntry),
					...(page.next === undefined ? {} : { next: page.next }),
				});
			if (previous && previous.value !== value) throw new Error("Memory page identity reused");
			this.db.prepare("INSERT OR IGNORE INTO pages VALUES (?, ?, ?)").run(manifest.checkpointId, page.cursor, value);
		});
	}
	activate(manifestId: string): void {
		this.transaction(() => {
			const row = this.db.prepare("SELECT manifest FROM staging WHERE id=?").get(manifestId);
			if (!row) {
				if (this.meta().manifest === manifestId) return;
				throw new Error("Missing staged memory checkpoint");
			}
			const manifest = JSON.parse(row.manifest as string) as SharedMemoryCheckpointManifest;
			const previous = this.meta();
			if (manifest.sequence < previous.sequence) throw new Error("Memory checkpoint rollback");
			const prefix = createHash("sha256"),
				previousDigest = digestMemory(this.rawEntries());
			// Replace only the base in a transaction. Outbox, receipts and conflicts are independent.
			this.db.exec("DELETE FROM entries; DELETE FROM replacements");
			let cursor = 0;
			for (const p of this.db
				.prepare("SELECT value FROM pages WHERE manifest=? ORDER BY cursor")
				.iterate(manifestId)) {
				const page = JSON.parse(p.value as string) as SharedMemoryCheckpointPage;
				if (page.cursor !== cursor) throw new Error("Memory checkpoint page gap or overlap");
				for (const entry of page.entries) {
					const raw = rawMemoryEntry(entry);
					if (cursor < previous.sequence) prefix.update(`${JSON.stringify(raw)}\n`);
					this.insert(raw);
					cursor++;
				}
			}
			if (cursor !== manifest.count || digestMemory(this.rawEntries()) !== manifest.digest)
				throw new Error("Incomplete memory checkpoint or digest mismatch");
			if (previous.complete && prefix.digest("hex") !== previousDigest)
				throw new Error("Memory checkpoint rewrites committed history");
			this.db
				.prepare("UPDATE meta SET sequence=?, complete=1, manifest=? WHERE id=1")
				.run(manifest.sequence, manifestId);
			this.db.prepare("DELETE FROM pages WHERE manifest=?").run(manifestId);
			this.db.prepare("DELETE FROM staging WHERE id=?").run(manifestId);
			this.settleReceipts();
		});
	}
	private insert(entry: MemoryEntry): void {
		for (const id of entry.replaces ?? []) {
			const prior = this.db.prepare("SELECT idx FROM entries WHERE id=?").get(id);
			if (!prior || Number(prior.idx) >= entry.index)
				throw new Error("Memory correction references unknown or future entry");
			this.db.prepare("INSERT OR REPLACE INTO replacements VALUES (?, ?)").run(id, entry.index);
		}
		this.db.prepare("INSERT INTO entries VALUES (?, ?, ?)").run(entry.index, entry.id, JSON.stringify(entry));
	}
	apply(batch: SharedMemoryChangePage): SharedMemoryReplicaState {
		pageSize(batch);
		if (
			!Number.isSafeInteger(batch.after) ||
			batch.after < 0 ||
			!Number.isSafeInteger(batch.head) ||
			batch.head < batch.after ||
			!Array.isArray(batch.changes) ||
			batch.changes.length > MEMORY_PAGE_LIMIT ||
			batch.checkpointRequired
		)
			throw new Error("Memory checkpoint required or invalid changes");
		const end = batch.after + batch.changes.length;
		if (
			end > batch.head ||
			(end < batch.head ? batch.next !== end || !batch.changes.length : batch.next !== undefined)
		)
			throw new Error("Invalid memory change continuation");
		for (let i = 0; i < batch.changes.length; i++) {
			const change = batch.changes[i]!;
			checkMemoryExport(change.entry.text);
			if (change.sequence !== batch.after + i + 1 || rawMemoryEntry(change.entry).index !== change.sequence - 1)
				throw new Error("Memory change sequence gap");
		}
		return this.transaction(() => {
			const meta = this.meta();
			if (!meta.complete || batch.after > meta.sequence)
				throw new Error("Memory change cursor gap; checkpoint required");
			for (const change of batch.changes) {
				const entry = rawMemoryEntry(change.entry);
				if (change.sequence <= meta.sequence) {
					const previous = this.db.prepare("SELECT value FROM entries WHERE idx=?").get(entry.index);
					if (previous?.value !== JSON.stringify(entry))
						throw new Error("Memory replay differs from committed base");
				} else this.insert(entry);
			}
			this.db.prepare("UPDATE meta SET sequence=? WHERE id=1").run(Math.max(meta.sequence, end));
			this.settleReceipts();
			return this.state();
		});
	}
	private *rawEntries(): IterableIterator<MemoryEntry> {
		for (const row of this.db.prepare("SELECT value FROM entries ORDER BY idx").iterate())
			yield JSON.parse(row.value as string);
	}
	proposals(): SharedMemoryProposal[] {
		return this.db
			.prepare(
				"SELECT mutation, state, reason FROM proposals WHERE state!='settled' AND (outcome IS NULL OR state IN ('conflict','rejected')) ORDER BY rowid",
			)
			.all()
			.map((row) => ({
				mutation: JSON.parse(row.mutation as string),
				state: row.state as SharedMemoryProposal["state"],
				...(row.reason ? { reason: row.reason as string } : {}),
			}));
	}
	queue(mutation: SharedMemoryMutation): SharedMemoryProposal {
		checkMutation(mutation);
		return this.transaction<SharedMemoryProposal>(() => {
			const json = JSON.stringify(mutation),
				existing = this.db
					.prepare("SELECT mutation, state, reason FROM proposals WHERE operation=?")
					.get(mutation.operationId);
			if (existing) {
				if (existing.mutation !== json) throw new Error("Memory proposal identity reused with different payload");
				return {
					mutation,
					state: existing.state === "settled" ? "pending" : (existing.state as SharedMemoryProposal["state"]),
					...(existing.reason ? { reason: existing.reason as string } : {}),
				};
			}
			if (!this.meta().complete) throw new Error("Shared memory replica is incomplete");
			if (
				Number(this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE state!='settled'").get()!.n) >=
				MAX_PROPOSALS
			)
				throw new Error("Memory proposal outbox full");
			const bytes = Number(
				this.db
					.prepare(
						"SELECT COALESCE(SUM(LENGTH(CAST(mutation AS BLOB))),0) AS n FROM proposals WHERE state!='settled'",
					)
					.get()!.n,
			);
			if (bytes + Buffer.byteLength(json) > MEMORY_PAGE_BYTES) throw new Error("Memory proposal overlay full");
			this.db.prepare("INSERT INTO proposals VALUES (?, ?, 'pending', NULL, NULL)").run(mutation.operationId, json);
			this.bumpOverlayRevision();
			return { mutation, state: "pending" };
		});
	}
	outcome(outcome: SharedMemoryCommitOutcome): void {
		memoryId(outcome.operationId);
		if (
			!Number.isSafeInteger(outcome.sequence) ||
			outcome.sequence < 0 ||
			!["committed", "already-present", "conflict", "rejected"].includes(outcome.state) ||
			(outcome.reason !== undefined &&
				(typeof outcome.reason !== "string" || Buffer.byteLength(outcome.reason) > 2048))
		)
			throw new Error("Invalid memory proposal outcome");
		if (
			["committed", "already-present"].includes(outcome.state) &&
			(!outcome.entry || rawMemoryEntry(outcome.entry).index >= outcome.sequence)
		)
			throw new Error("Memory commit outcome missing canonical entry");
		this.transaction(() => {
			const row = this.db
				.prepare("SELECT mutation, outcome FROM proposals WHERE operation=?")
				.get(outcome.operationId);
			if (!row) throw new Error("Unknown memory proposal outcome");
			const json = JSON.stringify(outcome);
			if (row.outcome) {
				if (row.outcome !== json) throw new Error("Memory proposal outcome changed");
				return;
			}
			const mutation = JSON.parse(row.mutation as string) as SharedMemoryMutation;
			if (outcome.state === "committed" && outcome.entry!.id !== mutation.noteId)
				throw new Error("Memory outcome note identity mismatch");
			// A successful receipt retires transmission, but the overlay remains until its base arrives.
			this.db
				.prepare("UPDATE proposals SET outcome=?, state=?, reason=? WHERE operation=?")
				.run(
					json,
					["conflict", "rejected"].includes(outcome.state) ? outcome.state : "pending",
					outcome.reason ?? null,
					outcome.operationId,
				);
			this.bumpOverlayRevision();
			this.settleReceipts();
		});
	}
	private settleReceipts(): void {
		for (const row of this.db
			.prepare(
				"SELECT operation, outcome FROM proposals WHERE state!='settled' AND outcome IS NOT NULL AND state='pending'",
			)
			.all()) {
			const outcome = JSON.parse(row.outcome as string) as SharedMemoryCommitOutcome;
			if (outcome.entry && this.meta().sequence >= outcome.sequence) {
				const entry = this.db.prepare("SELECT value FROM entries WHERE id=?").get(outcome.entry.id);
				if (!entry || entry.value !== JSON.stringify(rawMemoryEntry(outcome.entry)))
					throw new Error("Memory receipt does not match canonical replica");
				// Keep immutable receipt/operation dedupe, hide only the resolved overlay.
				this.db.prepare("UPDATE proposals SET state='settled' WHERE operation=?").run(row.operation as string);
				this.bumpOverlayRevision();
			}
		}
	}
	read(action: "wake" | "zoom", args: Record<string, unknown>): SharedMemoryRead {
		if (action !== "wake" && action !== "zoom") throw new Error("Unknown memory replica read operation");
		const state = this.state();
		if (!state.complete) throw new Error("Shared memory replica is incomplete");
		const lines = args.lines ?? 96;
		if (!Number.isInteger(lines) || Number(lines) < 1 || Number(lines) > 256)
			throw new Error("lines must be between 1 and 256");
		const node = (entry: MemoryEntry): MemoryNode => {
			const replacement = this.db.prepare("SELECT byIndex FROM replacements WHERE id=?").get(entry.id);
			return {
				lo: entry.index,
				hi: entry.index,
				text: entry.text,
				entry: replacement ? { ...entry, replacedBy: Number(replacement.byIndex) } : entry,
				...(replacement ? { replaced: true } : {}),
			};
		};
		let value: MemoryView | MemoryNode[];
		if (action === "wake") {
			const nodes: MemoryNode[] = [];
			let bytes = 0,
				omittedBefore = 0;
			for (const row of this.db
				.prepare(
					"SELECT value FROM entries WHERE NOT EXISTS (SELECT 1 FROM replacements WHERE replacements.id=entries.id) ORDER BY idx DESC",
				)
				.iterate()) {
				const entry = JSON.parse(row.value as string) as MemoryEntry;
				if (nodes.length >= Number(lines) || bytes + Buffer.byteLength(JSON.stringify(entry)) > 20_000) {
					omittedBefore = entry.index + 1;
					break;
				}
				nodes.push(node(entry));
				bytes += Buffer.byteLength(JSON.stringify(entry));
			}
			nodes.reverse();
			value = {
				count: state.sequence,
				nodes,
				omittedBefore,
				text:
					(omittedBefore ? `[Older memories #0-${omittedBefore - 1} omitted; use recall or zoom.]\n` : "") +
					nodes.map((n) => `#${n.lo} ${n.text}`).join("\n"),
			};
		} else {
			const lo = Number(args.lo),
				hi = Number(args.hi),
				size = hi - lo + 1;
			if (
				!Number.isSafeInteger(lo) ||
				!Number.isSafeInteger(hi) ||
				lo < 0 ||
				hi >= state.sequence ||
				size < 2 ||
				!Number.isInteger(Math.log2(size)) ||
				lo % size
			)
				throw new Error("Expected an existing aligned power-of-two block");
			value = [lo, lo + size / 2].map((start) => {
				const end = start + size / 2 - 1;
				if (start === end)
					return node(
						JSON.parse(this.db.prepare("SELECT value FROM entries WHERE idx=?").get(start)!.value as string),
					);
				const notes: MemoryNode[] = [];
				for (const row of this.db
					.prepare("SELECT value FROM entries WHERE idx BETWEEN ? AND ? ORDER BY idx LIMIT 8")
					.iterate(start, end))
					notes.push(node(JSON.parse(row.value as string)));
				return {
					lo: start,
					hi: end,
					text: `[Raw memory #${start}-${end}; zoom for full detail]\n${notes.map((n) => `#${n.lo}${n.replaced ? " [replaced]" : ""} ${n.text}`).join("\n")}`,
				};
			});
		}
		return { state, value, proposals: this.visibleProposals() };
	}
	visibleProposals(): SharedMemoryProposal[] {
		return this.db
			.prepare("SELECT mutation, state, reason FROM proposals WHERE state!='settled' ORDER BY rowid")
			.all()
			.map((row) => ({
				mutation: JSON.parse(row.mutation as string),
				state: row.state as SharedMemoryProposal["state"],
				...(row.reason ? { reason: row.reason as string } : {}),
			}));
	}
}

/** Runs only in a dedicated terminable recall worker. One read transaction pins base + overlay. */
export function recallReplica(path: string, regex: string, lines: number): SharedMemoryRead {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		db.exec("BEGIN");
		const meta = db.prepare("SELECT sequence, complete, overlayRevision FROM meta WHERE id=1").get()!;
		if (!meta.complete) throw new Error("Shared memory replica is incomplete");
		const pattern = new RegExp(regex, "i"),
			replacedBy = new Map<string, number>(),
			entries: MemoryEntry[] = [];
		let matches = 0,
			bytes = 0;
		for (const row of db.prepare("SELECT value FROM entries ORDER BY idx").iterate()) {
			const entry = JSON.parse(row.value as string) as MemoryEntry;
			for (const id of entry.replaces ?? []) replacedBy.set(id, entry.index);
			if (!pattern.test(`#${entry.index} ${new Date(entry.at).toISOString().slice(0, 10)} ${entry.text}`)) continue;
			matches++;
			entries.push(entry);
			bytes += Buffer.byteLength(JSON.stringify(entry));
			while (entries.length > lines || bytes > 20_000) bytes -= Buffer.byteLength(JSON.stringify(entries.shift()!));
		}
		const proposals = db
			.prepare("SELECT mutation, state, reason FROM proposals WHERE state!='settled' ORDER BY rowid")
			.all()
			.map((row) => ({
				mutation: JSON.parse(row.mutation as string),
				state: row.state as SharedMemoryProposal["state"],
				...(row.reason ? { reason: row.reason as string } : {}),
			}));
		const counts = db
			.prepare(
				"SELECT SUM(state='pending' AND outcome IS NULL) AS pending, SUM(state IN ('conflict','rejected')) AS conflicts FROM proposals",
			)
			.get()!;
		const value: MemoryRecall = {
			count: Number(meta.sequence),
			matches,
			entries: entries
				.reverse()
				.map((entry) => (replacedBy.has(entry.id) ? { ...entry, replacedBy: replacedBy.get(entry.id) } : entry)),
			truncated: matches > entries.length,
		};
		return {
			state: {
				sequence: Number(meta.sequence),
				complete: true,
				pendingCount: Number(counts.pending ?? 0),
				conflictCount: Number(counts.conflicts ?? 0),
				overlayRevision: Number(meta.overlayRevision),
			},
			value,
			proposals,
		};
	} finally {
		db.close();
	}
}
