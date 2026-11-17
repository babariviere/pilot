import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { DatabaseService, type DatabaseState, decideDatabaseRequest, postgresClientConfig } from "./databases.ts";

test("approval is explicit and pinned to destination and provider across reopen", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "database-authority-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "database.json");
	const config = (host: string) =>
		JSON.stringify({
			projects: {
				"/app": { environments: { prod: { read: { url: `postgres://reader@${host}/app`, access: "allow" } } } },
			},
		});
	await writeFile(path, config("one.example"), { mode: 0o600 });
	let state: DatabaseState = {};
	let provider = "anthropic";
	let calls = 0;
	const store = {
		read: () => state,
		write: async (s: DatabaseState) => {
			state = s;
		},
		authority: () => ({ provider, eligible: true }),
	};
	let service = new DatabaseService(dir, async () => {
		calls++;
		return [];
	});
	const query = () => service.call("agent", "/app", "query", { env: "prod", sql: "select 1" }, store);
	await assert.rejects(query(), /access/);
	await service.call("agent", "/app", "access", { env: "prod" }, store);
	assert.ok(state.request?.scope);
	state = decideDatabaseRequest(state, state.request!.id, true);
	service = new DatabaseService(dir, async () => {
		calls++;
		return [];
	});
	await query();
	assert.equal(calls, 1);
	await assert.rejects(
		service.call("another-agent", "/app", "query", { env: "prod", sql: "select 1" }, store),
		/access/,
	);
	provider = "openai";
	await assert.rejects(query(), /access/);
	provider = "anthropic";
	await writeFile(path, config("two.example"), { mode: 0o600 });
	await assert.rejects(query(), /access/);
	assert.equal(calls, 1);
});

test("queued queries recheck revocation and in-flight results cannot reach a changed provider", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "database-queue-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(
		join(dir, "database.json"),
		JSON.stringify({
			projects: { "/app": { environments: { prod: { read: { url: "postgres://reader@host/db" } } } } },
		}),
		{ mode: 0o600 },
	);
	let state: DatabaseState = {},
		eligible = true,
		provider = "anthropic",
		calls = 0;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const service = new DatabaseService(dir, async () => {
		if (++calls === 4) entered();
		await held;
		return [];
	});
	const store = {
		read: () => state,
		write: async (s: DatabaseState) => {
			state = s;
		},
		authority: () => ({ eligible, provider }),
	};
	await service.call("agent", "/app", "access", { env: "prod" }, store);
	state = decideDatabaseRequest(state, state.request!.id, true);
	const query = () => service.call("agent", "/app", "query", { env: "prod", sql: "select 1" }, store);
	const running = Array.from({ length: 4 }, () => query());
	await ready;
	const queued = query();
	eligible = false;
	provider = "openai";
	release();
	const results = await Promise.allSettled([...running, queued]);
	assert.equal(results.filter((r) => r.status === "rejected").length, 5);
	assert.equal(calls, 4);
});

test("TLS defaults to verified identity and unsafe modes require a named exception", () => {
	const base = { mode: "read" as const, applicationName: "test" };
	assert.equal(
		(postgresClientConfig({ ...base, url: "postgres://host/app" }).ssl as { rejectUnauthorized: boolean })
			.rejectUnauthorized,
		true,
	);
	assert.throws(() => postgresClientConfig({ ...base, url: "postgres://host/app?sslmode=disable" }), /exception/);
	assert.throws(() => postgresClientConfig({ ...base, url: "postgres://host/app?sslmode=no-verify" }), /exception/);
});

test("saving is passive; testing authenticates without SQL or data writes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "database-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const connect = t.mock.method(pg.Client.prototype, "connect", async () => {});
	const query = t.mock.method(pg.Client.prototype, "query", async () => {
		throw new Error("SQL is forbidden in connection tests");
	});
	const end = t.mock.method(pg.Client.prototype, "end", async () => {});
	const service = new DatabaseService(dir);
	const saved = await service.updateSettings("/app", {
		revision: "missing",
		environments: [{ name: "staging", write: { url: "postgres://writer@host/db" } }],
	});
	assert.equal(connect.mock.callCount(), 0);
	await service.testConnection("/app", "staging", "write", saved.revision);
	assert.equal(connect.mock.callCount(), 1);
	assert.equal(query.mock.callCount(), 0);
	assert.equal(end.mock.callCount(), 1);
	await assert.rejects(service.testConnection("/app", "staging", "write", "stale"), /changed/);
	assert.equal(connect.mock.callCount(), 1);
});
