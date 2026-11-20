import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DurableOperation, OperationHost } from "@pilot/protocol";
import { isChatOperation, isLocalOperation } from "./operation-journal.ts";

const remoteTables = [
	"shared_records",
	"shared_allocations",
	"shared_outbox",
	"shared_authority_scopes",
	"shared_entities",
	"shared_changes",
	"shared_internal_projection",
] as const;

function archiveRequired(source: string): Error {
	return new Error(
		`Legacy remote profile data found in ${source}. Stop the old runtime, resolve ownership on the original host, and archive the remote records and chats offline. Start Pilot with a verified Local-only profile. Nothing has been imported or replayed.`,
	);
}

/** Storage compatibility stops here. Only an empty legacy schema can be upgraded in place. */
export function assertLocalMissionDb(db: DatabaseSync): void {
	const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
	for (const table of remoteTables)
		if (hasTable.get(table) && db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get())
			throw archiveRequired(`missions.sqlite (${table})`);
}

export function dropEmptyRemoteTables(db: DatabaseSync): void {
	for (const table of [...remoteTables, "shared_storage_budget"]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
}

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const entries = (directory: string) =>
	readdir(directory).catch((error) => (absent(error) ? [] : Promise.reject(error)));
const text = (file: string) =>
	readFile(file, "utf8").catch((error) => (absent(error) ? undefined : Promise.reject(error)));

function profileJson<T>(raw: string, source: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`Cannot verify ${source}. Check the profile offline before starting Pilot.`);
	}
}

/** Called under the runtime's profile lock, before activation, schema changes or session recovery. */
export async function assertLocalProfile(home: string): Promise<void> {
	const database = join(home, "missions.sqlite");
	if (await lstat(database).catch((error) => (absent(error) ? undefined : Promise.reject(error)))) {
		const db = new DatabaseSync(database, { readOnly: true });
		try {
			assertLocalMissionDb(db);
		} finally {
			db.close();
		}
	}
	const updater = await lstat(join(home, "runtime-update", "current.json")).catch((error) =>
		absent(error) ? undefined : Promise.reject(error),
	);
	if (updater) throw archiveRequired("runtime-update/current.json");

	for (const id of await entries(join(home, "sessions"))) {
		if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
		for (const name of ["meta.json", "continuation.json"]) {
			const source = `sessions/${id}/${name}`;
			const raw = await text(join(home, source));
			if (raw === undefined) continue;
			if (profileJson<{ delegationFenced?: unknown }>(raw, source)?.delegationFenced) throw archiveRequired(source);
		}
	}

	let homeIdentity: OperationHost | undefined;
	for (const file of await entries(join(home, "operations"))) {
		if (!/^[0-9a-f]{64}\.json$/.test(file)) continue;
		const source = `operations/${file}`;
		const raw = await text(join(home, source));
		if (raw === undefined) continue;
		const operation = profileJson<{ operation?: DurableOperation }>(raw, source)?.operation;
		if (typeof operation?.kind !== "string")
			throw new Error(`Cannot verify ${source}. Check the profile offline before starting Pilot.`);
		if (operation.kind.startsWith("share-") || operation.kind.startsWith("control.")) throw archiveRequired(source);
		if (!isChatOperation(operation.kind)) continue;
		homeIdentity ??= {
			hostId: "daemon",
			daemonId: (await text(join(home, "daemon-id")))?.trim() ?? "",
			lineageId: (await text(join(home, "storage-lineage")))?.trim() ?? "",
		};
		if (!isLocalOperation(operation, homeIdentity)) throw archiveRequired(source);
	}
}
