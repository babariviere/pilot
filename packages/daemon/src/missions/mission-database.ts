/** The one SQLite connection behind missions.sqlite: in-memory reads and writes, saved to disk by a replica. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type Session, type SQLInputValue, type StatementSync } from "node:sqlite";
import { operations } from "../runtime/process/event-loop-watchdog.ts";
import { MissionReplica } from "./mission-replica.ts";

export type Row = Record<string, SQLInputValue>;

/**
 * What a committed mission change means for listeners. "passive" changes need no PR or main-branch refresh;
 * "preference" and "readModel" changes are passive and also leave mission contexts and coding capacity alone.
 */
export type ChangeKind = "full" | "passive" | "preference" | "readModel";

export interface TransactionOptions {
	/** Run the mission reconcilers (task phases, managed Linear sync) before commit. */
	reconcile?: boolean;
}

/** What stores sharing missions.sqlite get: the same connection, transactions, disk durability and change notices. */
export interface MissionDbPort {
	one(sql: string, ...params: SQLInputValue[]): Row | undefined;
	all(sql: string, ...params: SQLInputValue[]): Row[];
	run(sql: string, ...params: SQLInputValue[]): void;
	/** Joins the open transaction when there is one. Reconcile defaults to false here. */
	transaction<T>(work: () => T, options?: TransactionOptions): T;
	/** Resolves when every commit so far is on disk. Acknowledge writes to clients and chats only after it. */
	durable(): Promise<void>;
	/** Notifies mission listeners after a commit. */
	changed(missionId: string, kind?: ChangeKind): void;
}

export class MissionDatabase {
	private db: DatabaseSync;
	/** Saves each commit to missions.sqlite off the event loop. Absent for ":memory:" databases. */
	private replica?: MissionReplica;
	/** Records the changes of the current commit, for the replica. */
	private session?: Session;
	private open = false;
	private readonly file: string;

	constructor(file: string) {
		if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		this.file = file;
		this.db = new DatabaseSync(file);
	}

	/** Called once before any other use. `migrate` runs on the disk file before it is loaded into memory. */
	load(migrate: () => void): void {
		const file = this.file;
		try {
			migrate();
		} catch (error) {
			this.db.close();
			throw error;
		}
		if (file !== ":memory:") {
			// SQLite is synchronous and pilotd has one event loop, so a disk-backed connection made every read and
			// commit wait for a busy disk. The store runs in memory; a worker thread saves each commit to disk,
			// and callers acknowledge writes to clients and chats only after durable().
			this.db.close();
			this.db = loadInMemory(file);
			this.replica = new MissionReplica(file, (error) => console.warn(`pilotd: ${error.message}`));
		}
		// Search needs an indexed pin lookup across all missions. Build it only in memory; the
		// durable schema and replication stay unchanged.
		this.db.exec(
			"CREATE INDEX artifact_search_owner ON artifact_links(session_id, artifact_id, id) WHERE revision IS NOT NULL",
		);
		if (this.replica) this.session = this.db.createSession();
	}

	/** True while a transaction is open. */
	get writing(): boolean {
		return this.open;
	}

	/** The raw connection, for startup migrations only. */
	get connection(): DatabaseSync {
		return this.db;
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	/** Untimed statement for repeated writes inside a transaction, or for its changes and lastInsertRowid. */
	prepare(sql: string): StatementSync {
		return this.db.prepare(sql);
	}

	all(sql: string, ...params: SQLInputValue[]): Row[] {
		return this.timed(sql, () => this.db.prepare(sql).all(...params) as Row[]);
	}

	one(sql: string, ...params: SQLInputValue[]): Row | undefined {
		return this.timed(sql, () => this.db.prepare(sql).get(...params) as Row | undefined);
	}

	run(sql: string, ...params: SQLInputValue[]): void {
		this.timed(sql, () => this.db.prepare(sql).run(...params));
	}

	/** BEGIN IMMEDIATE, then commit and ship the changes to the replica. Nested calls join the open transaction. */
	transaction<T>(work: () => T): T {
		if (this.open) return work();
		return operations.time("missions.sqlite transaction", () => {
			this.db.exec("BEGIN IMMEDIATE");
			this.open = true;
			try {
				const result = work();
				this.db.exec("COMMIT");
				return result;
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			} finally {
				this.open = false;
				// After a rollback the changeset is empty, or a no-op for rows the session saw change back.
				this.replicate();
			}
		});
	}

	durable(): Promise<void> {
		return this.replica?.durable() ?? Promise.resolve();
	}

	/** Like durable(), but undefined when nothing is waiting for the disk, so callers can stay synchronous. */
	whenDurable(): Promise<void> | undefined {
		return this.replica?.pending ? this.replica.durable() : undefined;
	}

	/** Waits (limited) for unsaved commits; pilotd only closes the store at shutdown. */
	close(): void {
		this.session?.close();
		this.session = undefined;
		this.replica?.close();
		this.replica = undefined;
		this.db.close();
	}

	/**
	 * SQLite runs synchronously on pilotd's event loop. Attribute slow statements outside transactions, and whole
	 * transactions, in event-loop stall reports.
	 */
	private timed<T>(sql: string, work: () => T): T {
		if (this.open) return work();
		const result = operations.time(() => `missions.sqlite ${sql.replace(/\s+/g, " ").trim().slice(0, 48)}`, work);
		// An autocommit write. A no-op produces an empty changeset, which is not shipped.
		if (this.session && !/^\s*(SELECT|PRAGMA)\b/i.test(sql)) this.replicate();
		return result;
	}

	private replicate(): void {
		if (!this.session || !this.replica) return;
		const changes = this.session.changeset();
		if (!changes.length) return;
		this.session.close();
		this.session = this.db.createSession();
		this.replica.push(changes);
	}
}

/** Quotes an SQLite identifier read from sqlite_master. */
export function sqlIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Copies a migrated missions.sqlite into an in-memory database with the same schema, rows and AUTOINCREMENT
 * counters. Indexes are created after the rows. Foreign keys are enforced from then on.
 */
function loadInMemory(file: string): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = OFF");
	db.prepare("ATTACH DATABASE ? AS disk").run(file);
	try {
		const objects = db
			.prepare(
				`SELECT type, name, sql FROM disk.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
				ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid`,
			)
			.all() as { type: string; name: string; sql: string }[];
		db.exec("BEGIN");
		for (const object of objects) {
			db.exec(object.sql);
			if (object.type === "table")
				db.exec(`INSERT INTO main.${sqlIdentifier(object.name)} SELECT * FROM disk.${sqlIdentifier(object.name)}`);
		}
		const sequence = "SELECT 1 FROM %s.sqlite_master WHERE name = 'sqlite_sequence'";
		if (db.prepare(sequence.replace("%s", "disk")).get() && db.prepare(sequence.replace("%s", "main")).get())
			db.exec("INSERT INTO main.sqlite_sequence SELECT * FROM disk.sqlite_sequence");
		db.exec("COMMIT");
	} finally {
		db.exec("DETACH DATABASE disk");
	}
	db.exec("PRAGMA foreign_keys = ON");
	return db;
}
