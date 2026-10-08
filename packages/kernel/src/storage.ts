/** Private durable storage with an OS-released, cross-process single-writer lease. */
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	CURRENT_SQLITE_SCHEMA_VERSION,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteValue,
	SqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite";

function privateFile(file: string): void {
	const fd = openSync(file, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
	closeSync(fd);
	if (!lstatSync(file).isFile()) throw new Error(`Durable storage is not a regular file: ${file}`);
	chmodSync(file, 0o600);
}

export class StorageBusy extends Error {}

/**
 * A committed read transaction, not a storage owner. Never creates a database, changes permissions,
 * checkpoints WAL, migrates a schema, or acquires the worker's writer lease. SQLite may create its
 * WAL read-coordination sidecars, which must remain enabled to see a concurrent writer's commits.
 */
export async function openSessionReader(directory: string): Promise<Storage | undefined> {
	const file = join(resolve(directory), "harness.sqlite");
	try {
		if (!lstatSync(file).isFile()) throw new Error(`Durable storage is not a regular file: ${file}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const db = new DatabaseSync(file, { readOnly: true });
	let closed = false;
	let bootstrap = true;
	let tail = Promise.resolve();
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const rejectWrite = () => {
		throw new Error("Session snapshot storage is read-only");
	};
	const executor: SqliteExecutor = {
		async get<T extends object>(sql: string, ...params: SqliteValue[]) {
			return db.prepare(sql).get(...params) as T | undefined;
		},
		async all<T extends object>(sql: string, ...params: SqliteValue[]) {
			return db.prepare(sql).all(...params) as T[];
		},
		async exec(sql) {
			// SqliteStorage.open unconditionally attempts these two bootstrap statements, even
			// for a current schema. Validate first, then skip only these exact harmless attempts.
			if (
				bootstrap &&
				sql.replace(/\s+/g, " ").trim() ===
					"CREATE TABLE IF NOT EXISTS durable_schema ( singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL CHECK (version >= 0) ) STRICT"
			)
				return;
			rejectWrite();
		},
		async run(sql) {
			if (bootstrap && sql === "INSERT OR IGNORE INTO durable_schema (singleton, version) VALUES (1, 0)") return;
			rejectWrite();
		},
	};
	const facade: SqliteDatabase = {
		get: <T extends object>(sql: string, ...params: SqliteValue[]) => enqueue(() => executor.get<T>(sql, ...params)),
		all: <T extends object>(sql: string, ...params: SqliteValue[]) => enqueue(() => executor.all<T>(sql, ...params)),
		exec: (sql) => enqueue(() => executor.exec(sql)),
		run: (sql, ...params) => enqueue(() => executor.run(sql, ...params)),
		transaction: (callback) =>
			enqueue(async () => {
				// Materialization also uses transactions. Queue unrelated reads/close until it
				// settles, while all reads still share the outer committed SQLite snapshot.
				let active = true;
				const check = () => {
					if (!active) throw new Error("Session reader transaction is no longer active");
				};
				const transaction: SqliteExecutor = {
					async get<T extends object>(sql: string, ...params: SqliteValue[]) {
						check();
						return executor.get<T>(sql, ...params);
					},
					async all<T extends object>(sql: string, ...params: SqliteValue[]) {
						check();
						return executor.all<T>(sql, ...params);
					},
					async exec(sql) {
						check();
						return executor.exec(sql);
					},
					async run(sql, ...params) {
						check();
						return executor.run(sql, ...params);
					},
				};
				try {
					return await callback(transaction);
				} finally {
					active = false;
				}
			}),
		close: () =>
			enqueue(async () => {
				if (closed) return;
				closed = true;
				try {
					db.exec("ROLLBACK");
				} finally {
					db.close();
				}
			}),
	};
	try {
		db.exec("BEGIN");
		const schema = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get();
		if (schema?.version !== CURRENT_SQLITE_SCHEMA_VERSION)
			throw new Error(`Unsupported durable snapshot schema: ${schema?.version}`);
		const storage = await SqliteStorage.open(facade);
		bootstrap = false;
		return storage;
	} catch (error) {
		await facade.close();
		throw error;
	}
}

export async function openSessionStorage(directory: string): Promise<{ storage: Storage; release(): void }> {
	const root = resolve(directory);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (!lstatSync(root).isDirectory()) throw new Error(`Durable storage is not a directory: ${root}`);
	chmodSync(root, 0o700);
	const lockPath = join(root, "owner.sqlite");
	privateFile(lockPath);
	// Hold an exclusive transaction for the worker's lifetime. The OS releases it even after
	// SIGKILL, so there is no stale PID guessing and no lockfile to delete.
	const lease = new DatabaseSync(lockPath, { timeout: 0 });
	try {
		lease.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		lease.close();
		throw new StorageBusy(`Session storage already has an owner: ${root}`, { cause: error });
	}
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		lease.close();
	};
	try {
		const file = join(root, "harness.sqlite");
		privateFile(file);
		return { storage: await openNodeSqliteStorage(file), release };
	} catch (error) {
		release();
		throw error;
	}
}
