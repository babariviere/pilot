/** Private durable storage with an OS-released, cross-process single-writer lease. */
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

function privateFile(file: string): void {
	const fd = openSync(file, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
	closeSync(fd);
	if (!lstatSync(file).isFile()) throw new Error(`Durable storage is not a regular file: ${file}`);
	chmodSync(file, 0o600);
}

export class StorageBusy extends Error {}

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
