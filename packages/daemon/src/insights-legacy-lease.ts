/** Probe the kernel's existing OS-released writer lease without opening history or creating files. */
import type { BigIntStats } from "node:fs";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Conflict } from "./errors.ts";
import { canonicalJSON, payloadHash } from "./operation-journal.ts";

const signature = (s: BigIntStats) =>
	canonicalJSON([s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String));
export async function legacyInsightsWriterLease(directory: string, guard: () => void) {
	guard();
	const file = join(directory, "owner.sqlite");
	let db: DatabaseSync | undefined;
	try {
		if (resolve(directory) !== directory || (await realpath(directory)) !== directory)
			throw new Conflict("legacy_executor_storage_aliased");
		const before = await lstat(file, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
			throw new Conflict("legacy_executor_storage_aliased");
		guard();
		db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
		// owner.sqlite is the kernel's lease-only database. This writes no bytes, schema or sidecars.
		db.exec("BEGIN EXCLUSIVE");
		let closed = false;
		const digest = payloadHash(signature(before));
		const revalidate = () => {
			try {
				if (
					closed ||
					realpathSync(directory) !== directory ||
					payloadHash(signature(lstatSync(file, { bigint: true }))) !== digest
				)
					throw new Error("changed");
			} catch {
				throw new Conflict("legacy_executor_storage_proof_changed");
			}
		};
		const close = () => {
			if (!closed) {
				closed = true;
				db!.close();
			}
		};
		try {
			guard();
			revalidate();
		} catch (error) {
			close();
			throw error;
		}
		return { proof: { kind: "closed_writer_lease" as const, digest }, revalidate, close };
	} catch (error) {
		if (db?.isOpen) db.close();
		if (error instanceof Conflict) throw error;
		throw new Conflict("legacy_executor_storage_busy_or_unavailable_use_exact_recovery");
	}
}
