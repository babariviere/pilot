import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MissionStore } from "./missions.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { assertLocalProfile } from "./profile-cutover.ts";

const host = { hostId: "local", daemonId: "mac", lineageId: "local-history" };
const target = { hostId: "box", daemonId: "linux", lineageId: "remote-history" };

async function profile(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-profile-cutover-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	return home;
}

for (const [table, schema, row] of [
	["shared_records", "namespace TEXT, id TEXT, value TEXT", "'execution-session','dangling','{}'"],
	["shared_allocations", "task_id TEXT, sealed INTEGER", "'task',1"],
	["shared_outbox", "value TEXT", "'waiting'"],
	["shared_authority_scopes", "mission_id TEXT", "'mission'"],
	["shared_entities", "value TEXT", "'history'"],
	["shared_changes", "value TEXT", "'change'"],
]) {
	test(`refuses nonempty ${table} even if execution is sealed or dangling`, async (t) => {
		const home = await profile(t);
		const file = join(home, "missions.sqlite");
		const db = new DatabaseSync(file);
		try {
			db.exec(`PRAGMA journal_mode=WAL;
				CREATE TABLE ${table} (${schema});
				PRAGMA wal_checkpoint(TRUNCATE);
				INSERT INTO ${table} VALUES (${row})`);
			const before = await readFile(file);
			const wal = await readFile(`${file}-wal`);
			await assert.rejects(assertLocalProfile(home), { message: new RegExp(`missions.sqlite.*${table}.*archive`) });
			assert.throws(() => new MissionStore(file), /archive the remote records/);
			assert.deepEqual(await readFile(file), before);
			assert.deepEqual(await readFile(`${file}-wal`), wal);
			assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 1);
		} finally {
			db.close();
		}
	});
}

test("a clean legacy schema migrates local definition revisions once without remote tables or triggers", async (t) => {
	const home = await profile(t);
	const file = join(home, "missions.sqlite");
	let store = new MissionStore(file);
	const mission = store.create({ title: "Local", projectId: "p", tasks: [{ title: "Task" }] });
	const task = store.tasks(mission.id)[0]!;
	store.updateTask(mission.id, task.id, { body: "Existing edit" });
	const revision = store.sharedDefinitionRevision(task.id);
	assert.ok(revision > 1);
	await store.durable();
	store.close();
	const old = new DatabaseSync(file);
	old.exec(`ALTER TABLE task_definition_revisions RENAME TO shared_task_definitions;
		CREATE TABLE shared_records(value TEXT);
		CREATE TABLE shared_allocations(value TEXT);
		CREATE TABLE shared_outbox(value TEXT);
		CREATE TABLE shared_storage_budget(bytes INTEGER);
		INSERT INTO shared_storage_budget VALUES(0);
		CREATE TRIGGER shared_tasks_UPDATE AFTER UPDATE ON tasks BEGIN INSERT INTO shared_outbox VALUES('never'); END;`);
	old.close();

	await assertLocalProfile(home);
	store = new MissionStore(file);
	assert.equal(store.sharedDefinitionRevision(task.id), revision);
	store.updateTask(mission.id, task.id, { body: "Next edit" });
	assert.equal(store.sharedDefinitionRevision(task.id), revision + 1);
	await store.durable();
	store.close();

	const disk = new DatabaseSync(file, { readOnly: true });
	try {
		assert.deepEqual(disk.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'shared_*'").all(), []);
		assert.equal(
			disk.prepare("SELECT revision FROM task_definition_revisions WHERE id=?").get(task.id)?.revision,
			revision + 1,
		);
	} finally {
		disk.close();
	}
});

test("orphaned delegated chats, continuations and updater records require offline archive", async (t) => {
	const home = await profile(t);
	const id = randomUUID();
	const prefix = join(home, "sessions", id);
	await mkdir(prefix, { recursive: true });
	await mkdir(join(home, "runtime-update"));
	for (const [path, bytes] of [
		[join(prefix, "meta.json"), JSON.stringify({ delegationFenced: true, pending: [{ content: "Never run" }] })],
		[join(prefix, "continuation.json"), JSON.stringify({ delegationFenced: true })],
		[join(home, "runtime-update", "current.json"), '{"phase":"completed"}'],
	]) {
		await writeFile(path!, bytes!);
		await assert.rejects(assertLocalProfile(home), /archive the remote records/);
		assert.equal(await readFile(path!, "utf8"), bytes);
		await rm(path!);
	}
	await assertLocalProfile(home);
});

test("legacy operation records must be archived, not recovered or rewritten", async (t) => {
	const home = await profile(t);
	await writeFile(join(home, "daemon-id"), host.daemonId);
	await writeFile(join(home, "storage-lineage"), host.lineageId);
	const journal = new OperationJournal(join(home, "operations"), host);
	for (const [kind, origin] of [
		["share-note", host],
		["control.start", host],
		["chat-create-attached", target],
		["chat-send", { ...host, hostId: "box" }],
	] as const) {
		const op = {
			schemaVersion: 1 as const,
			operationId: randomUUID(),
			producerId: randomUUID(),
			origin,
			destination: { ...host, hostId: "daemon" },
			sequence: 1,
			kind,
			targetId: randomUUID(),
			payload: "{}",
			payloadHash: payloadHash("{}"),
		};
		await journal.reserve(op);
		const file = join(home, "operations", `${payloadHash(op.operationId)}.json`);
		const before = await readFile(file);
		await assert.rejects(assertLocalProfile(home), /archive the remote records/);
		assert.deepEqual(await readFile(file), before);
		await rm(file);
	}
});

test("daemon entry refuses before loading a service graph", async (t) => {
	const home = await profile(t);
	const db = new DatabaseSync(join(home, "missions.sqlite"));
	db.exec("CREATE TABLE shared_records(value TEXT); INSERT INTO shared_records VALUES('remote');");
	db.close();
	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as AddressInfo).port;
	await new Promise<void>((resolve) => listener.close(() => resolve()));
	const agent = join(home, "agent");
	await assert.rejects(
		promisify(execFile)(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
			env: {
				HOME: home,
				PATH: process.env.PATH,
				PILOT_HOME: home,
				PILOT_AGENT_DIR: agent,
				PILOT_PORT: String(port),
				NODE_DISABLE_COMPILE_CACHE: "1",
			},
			timeout: 10_000,
		}),
		/Legacy remote profile data found.*archive the remote records/,
	);
	await assert.rejects(readFile(join(home, "daemon-id")), { code: "ENOENT" });
});
