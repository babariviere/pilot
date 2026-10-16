/** Synchronous storage, used ONLY in the existing memory worker. SQLite repairs interrupted
 * transactions, keeping the append, tree queue and persisted view in one durable commit. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	CONTROL_VIEW_HIGH,
	CONTROL_VIEW_LOW,
	type ControlLine,
	controlLine,
	mergeControlView,
} from "./control-view.ts";

export type ControlMessageKind = "user" | "assistant" | "tool" | "echo" | "event" | "note";
export interface ControlMessageInput {
	kind: ControlMessageKind;
	text: string;
	name?: string;
	input?: unknown;
	at?: number;
	/** Stable delivery/entry key. Retries return the original message IDs. */
	key?: string;
}
export interface ControlMessage extends ControlMessageInput {
	id: number;
	at: number;
}
export interface ControlJob {
	id: number;
	n: number;
	source: string;
}
export interface ControlMemoryState {
	count: number;
	pending: number;
	viewBytes: number;
	merging: boolean;
}
const PENDING = "(not summarized yet: zoom it)";
export const CONTROL_NODE_BYTES = 512;
const kinds = new Set(["user", "assistant", "tool", "echo", "event", "note"]);
function source(message: ControlMessageInput): string {
	return message.kind === "tool"
		? `tool: ${message.name} ${JSON.stringify(message.input)}`
		: `${message.kind}: ${message.text}`;
}
function range(id: number, n: number): void {
	if (
		!Number.isSafeInteger(id) ||
		id < 0 ||
		!Number.isSafeInteger(n) ||
		n < 1 ||
		!Number.isInteger(Math.log2(n)) ||
		id % n
	)
		throw new Error("Expected id+n with an aligned power-of-two n");
}
export class ControlMemoryDisk {
	private readonly lease: DatabaseSync;
	private readonly db: DatabaseSync;
	constructor(dir: string) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// Same non-expiring, OS-released owner lease as project memory. Never unlink the lock.
		this.lease = new DatabaseSync(join(dir, "owner.sqlite"), { timeout: 0 });
		try {
			this.lease.exec("BEGIN EXCLUSIVE");
		} catch (error) {
			this.lease.close();
			throw error;
		}
		try {
			this.db = new DatabaseSync(join(dir, "chat.sqlite"));
			this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
				CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, key TEXT UNIQUE, at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
				CREATE TRIGGER IF NOT EXISTS messages_no_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'append only'); END;
				CREATE TRIGGER IF NOT EXISTS messages_no_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'append only'); END;
				CREATE TABLE IF NOT EXISTS nodes (id INTEGER NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(id,n));
				CREATE TRIGGER IF NOT EXISTS nodes_no_update BEFORE UPDATE ON nodes BEGIN SELECT RAISE(ABORT, 'built once'); END;
				CREATE TRIGGER IF NOT EXISTS nodes_no_delete BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT, 'built once'); END;
				CREATE TABLE IF NOT EXISTS view (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS compact_view (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS jobs (id INTEGER NOT NULL, n INTEGER NOT NULL, source TEXT NOT NULL, state INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(id,n));
				CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state,id,n);
				CREATE INDEX IF NOT EXISTS jobs_leaves ON jobs(id) WHERE n=1;
				CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
				INSERT INTO compact_view SELECT * FROM view WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='compactBytes');
				INSERT OR IGNORE INTO meta VALUES ('count',0), ('bytes',0), ('merging',0), ('compactBytes',0);
				UPDATE jobs SET state=0 WHERE state=1;`);
			this.setMeta(
				"compactBytes",
				this.compactLines().reduce((sum, line) => sum + Buffer.byteLength(controlLine(line)), 0),
			);
		} catch (error) {
			this.lease.close();
			throw error;
		}
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
	private meta(key: string): number {
		return Number(this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)!.value);
	}
	private setMeta(key: string, value: number): void {
		this.db.prepare("UPDATE meta SET value=? WHERE key=?").run(value, key);
	}
	state(): ControlMemoryState {
		return {
			count: this.meta("count"),
			pending: Number(this.db.prepare("SELECT count(*) AS n FROM jobs").get()!.n),
			viewBytes: this.meta("bytes"),
			merging: !!this.meta("merging"),
		};
	}
	append(input: ControlMessageInput): ControlMessage[] {
		if (!input || !kinds.has(input.kind) || typeof input.text !== "string" || input.text.includes("\0"))
			throw new Error("Invalid control message");
		if (Buffer.byteLength(input.text) > 4_000_000) throw new Error("Control message exceeds 4 MB; send in parts");
		if (Buffer.byteLength(JSON.stringify(input)) > 4_100_000) throw new Error("Control message payload exceeds 4 MB");
		if (
			input.kind === "tool" &&
			(typeof input.name !== "string" || !input.name || JSON.stringify(input.input) === undefined)
		)
			throw new Error("Tool messages require name and input");
		if (input.key !== undefined && (typeof input.key !== "string" || !input.key || input.key.length > 512))
			throw new Error("Invalid message key");
		if (input.at !== undefined && (!Number.isSafeInteger(input.at) || input.at < 0))
			throw new Error("Invalid message date");
		// Echoes alone are clipped. Other long text is split, not dropped (UTF-16 pairs stay intact).
		const text =
			input.kind === "echo" && input.text.length > 30_000
				? `${input.text.slice(0, 14_980)}\n[tool result clipped]\n${input.text.slice(-14_980)}`
				: input.text;
		const parts: string[] = [];
		for (let i = 0; i < text.length || !parts.length; ) {
			let end = Math.min(text.length, i + 30_000);
			if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
			parts.push(text.slice(i, end));
			i = end;
		}
		return this.transaction(() => {
			if (input.key) {
				const existing = this.db
					.prepare("SELECT payload FROM messages WHERE key=? OR key GLOB ? ORDER BY id")
					.all(input.key, `${input.key.replace(/[[*?]/g, "[$&]")}:part:*`);
				if (existing.length) return existing.map((row) => JSON.parse(String(row.payload)) as ControlMessage);
			}
			this.db.exec("UPDATE jobs SET state=0 WHERE state=2"); // Failed calls retry only on the next message.
			const out: ControlMessage[] = [];
			for (const [part, text] of parts.entries()) {
				const id = this.meta("count"),
					key = input.key ? (part ? `${input.key}:part:${part}` : input.key) : undefined;
				const message: ControlMessage = { ...input, text, id, at: input.at ?? Date.now(), ...(key ? { key } : {}) };
				this.db
					.prepare("INSERT INTO messages VALUES (?,?,?,?,?)")
					.run(id, key ?? null, message.at, message.kind, JSON.stringify(message));
				this.db.prepare("INSERT INTO view VALUES (?,1)").run(id);
				this.db.prepare("INSERT INTO compact_view VALUES (?,1)").run(id);
				this.setMeta("count", id + 1);
				this.setMeta("bytes", this.meta("bytes") + Buffer.byteLength(controlLine({ id, n: 1, text: PENDING })));
				this.setMeta(
					"compactBytes",
					this.meta("compactBytes") + Buffer.byteLength(controlLine({ id, n: 1, text: PENDING })),
				);
				this.enqueue(id, 1, source(message));
				out.push(message);
			}
			this.reduce();
			this.reduceCompact();
			return out;
		});
	}
	private node(id: number, n: number): string | undefined {
		return this.db.prepare("SELECT text FROM nodes WHERE id=? AND n=?").get(id, n)?.text as string | undefined;
	}
	private enqueue(id: number, n: number, text: string): void {
		if (Buffer.byteLength(text) <= CONTROL_NODE_BYTES) this.build(id, n, text);
		else this.db.prepare("INSERT OR IGNORE INTO jobs(id,n,source) VALUES (?,?,?)").run(id, n, text);
	}
	private build(id: number, n: number, text: string): void {
		this.db.prepare("INSERT INTO nodes VALUES (?,?,?)").run(id, n, text);
		this.db.prepare("DELETE FROM jobs WHERE id=? AND n=?").run(id, n);
		if (this.db.prepare("SELECT 1 FROM view WHERE id=? AND n=?").get(id, n))
			this.setMeta(
				"bytes",
				this.meta("bytes") +
					Buffer.byteLength(controlLine({ id, n, text })) -
					Buffer.byteLength(controlLine({ id, n, text: PENDING })),
			);
		if (this.db.prepare("SELECT 1 FROM compact_view WHERE id=? AND n=?").get(id, n))
			this.setMeta(
				"compactBytes",
				this.meta("compactBytes") +
					Buffer.byteLength(controlLine({ id, n, text })) -
					Buffer.byteLength(controlLine({ id, n, text: PENDING })),
			);
		const parentId = Math.floor(id / (n * 2)) * n * 2;
		const left = this.node(parentId, n),
			right = this.node(parentId + n, n);
		if (left !== undefined && right !== undefined) this.enqueue(parentId, n * 2, `${left}\n${right}`);
	}
	view(): ControlLine[] {
		return this.db
			.prepare(
				"SELECT v.id,v.n,coalesce(t.text,?) AS text FROM view v LEFT JOIN nodes t ON v.id=t.id AND v.n=t.n ORDER BY v.id",
			)
			.all(PENDING) as unknown as ControlLine[];
	}
	private reduce(): void {
		if (this.meta("bytes") > CONTROL_VIEW_HIGH) this.setMeta("merging", 1);
		if (!this.meta("merging")) return;
		const { lines, merges } = mergeControlView(this.view(), this.meta("count"), (id, n) => this.node(id, n), {
			bytes: CONTROL_VIEW_LOW,
		});
		for (const line of merges) {
			this.db.prepare("DELETE FROM view WHERE id=? OR id=?").run(line.id, line.id + line.n / 2);
			this.db.prepare("INSERT INTO view VALUES (?,?)").run(line.id, line.n);
		}
		const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(controlLine(line)), 0);
		this.setMeta("bytes", bytes);
		if (bytes <= CONTROL_VIEW_LOW) this.setMeta("merging", 0);
		if (merges.length) {
			this.db.exec("DELETE FROM compact_view; INSERT INTO compact_view SELECT * FROM view");
			this.setMeta("compactBytes", bytes);
			this.reduceCompact(true);
		}
	}
	private compactLines(): ControlLine[] {
		return this.db
			.prepare(
				"SELECT v.id,v.n,coalesce(t.text,?) AS text FROM compact_view v LEFT JOIN nodes t ON v.id=t.id AND v.n=t.n ORDER BY v.id",
			)
			.all(PENDING) as unknown as ControlLine[];
	}
	private reduceCompact(force = false): void {
		if (!force && this.meta("compactBytes") <= 32_000) return;
		const { lines, merges } = mergeControlView(this.compactLines(), this.meta("count"), (id, n) => this.node(id, n), {
			bytes: 16_000,
		});
		for (const line of merges) {
			this.db.prepare("DELETE FROM compact_view WHERE id=? OR id=?").run(line.id, line.id + line.n / 2);
			this.db.prepare("INSERT INTO compact_view VALUES (?,?)").run(line.id, line.n);
		}
		this.setMeta(
			"compactBytes",
			lines.reduce((sum, line) => sum + Buffer.byteLength(controlLine(line)), 0),
		);
	}
	/** Built-only prefix ending at the job. Descend a boundary range, never scan the tree. */
	context(id: number, n: number): ControlLine[] {
		range(id, n);
		const end = n === 1 ? id : id + n;
		const out: ControlLine[] = [];
		let bytes = 0,
			stopped = false;
		const add = (line: ControlLine) => {
			if (stopped || line.id >= end) return;
			if (line.id + line.n > end && line.n > 1) {
				for (const id of [line.id, line.id + line.n / 2]) add({ id, n: line.n / 2, text: "" });
				return;
			}
			const text = this.node(line.id, line.n);
			if (text === undefined) {
				stopped = true;
				return;
			}
			const built = { ...line, text },
				size = Buffer.byteLength(controlLine(built));
			if (bytes + size > 32_000) {
				stopped = true;
				return;
			}
			out.push(built);
			bytes += size;
		};
		for (const line of this.compactLines()) add(line);
		return out;
	}
	/** Ready queue, not a scan of the tree. A caller owns each claimed node until put/fail. */
	next(): ControlJob | undefined {
		const job = this.db
			.prepare(
				"SELECT id,n,source FROM jobs WHERE state=0 AND (n>1 OR id<=coalesce((SELECT id FROM jobs WHERE n=1 ORDER BY id LIMIT 1 OFFSET 7),9223372036854775807)) ORDER BY id,n LIMIT 1",
			)
			.get() as unknown as ControlJob | undefined;
		if (job) this.db.prepare("UPDATE jobs SET state=1 WHERE id=? AND n=?").run(job.id, job.n);
		return job;
	}
	put(id: number, n: number, text: string): void {
		range(id, n);
		if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > CONTROL_NODE_BYTES)
			throw new Error("Expected a nonempty summary of at most 512 UTF-8 bytes");
		this.transaction(() => {
			if (!this.db.prepare("SELECT 1 FROM jobs WHERE id=? AND n=? AND state=1").get(id, n))
				throw new Error("Node is not claimed");
			this.build(id, n, text);
			this.reduce();
			this.reduceCompact();
		});
	}
	fail(id: number, n: number): void {
		this.db.prepare("UPDATE jobs SET state=2 WHERE id=? AND n=? AND state=1").run(id, n);
	}
	/** Raw log reads are paged and never used to reconstruct the persisted view. */
	message(id: number, offset = 0): { message: Omit<ControlMessage, "text"> & { text: string }; next?: number } {
		range(id, 1);
		if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid page offset");
		const row = this.db.prepare("SELECT payload FROM messages WHERE id=?").get(id);
		if (!row) throw new Error("Unknown message");
		const message = JSON.parse(String(row.payload)) as ControlMessage;
		let end = Math.min(message.text.length, offset + 12_000);
		if (end < message.text.length && /[\uD800-\uDBFF]/.test(message.text[end - 1]!)) end--;
		return {
			message: { ...message, text: message.text.slice(offset, end) },
			...(end < message.text.length ? { next: end } : {}),
		};
	}
	children(id: number, n: number): ControlLine[] {
		range(id, n);
		if (n === 1 || id + n > this.meta("count")) throw new Error("Expected an existing summary range");
		return [id, id + n / 2].map((id) => ({ id, n: n / 2, text: this.node(id, n / 2) ?? PENDING }));
	}
	date(id: number): string {
		range(id, 1);
		const row = this.db.prepare("SELECT at FROM messages WHERE id=?").get(id);
		if (!row) throw new Error("Unknown message");
		return new Date(Number(row.at)).toISOString();
	}
	close(): void {
		this.db.close();
		this.lease.close();
	}
}
