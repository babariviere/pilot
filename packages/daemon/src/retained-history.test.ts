import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openSessionStorage } from "../../kernel/src/storage.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "retained-history-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const starts: string[] = [];
	const managers: SessionManager[] = [];
	t.after(async () => {
		await Promise.all(managers.map((manager) => manager.shutdown()));
		await rm(home, { recursive: true, force: true });
	});
	const open = async () => {
		const manager = new SessionManager(home, projects, undefined, {
			title: async () => undefined,
			worker: (spec, onPacket) => {
				starts.push(spec.sessionId);
				queueMicrotask(() => onPacket({ type: "ready", model: "test/model", working: false, usage: {} }));
				return {
					state: "idle",
					busy: false,
					ready: Promise.resolve(),
					send: () => {},
					close: async () => {},
					request: async () => {},
				};
			},
		});
		managers.push(manager);
		await manager.load();
		return manager;
	};
	const seed = async (id: string, metadata: Record<string, unknown>) => {
		const dir = join(home, "sessions", id);
		await mkdir(dir, { recursive: true });
		const path = join(dir, "meta.json");
		await writeFile(
			path,
			JSON.stringify({ id, title: "Retained", cwd: home, createdAt: 1, updatedAt: 2, ...metadata }),
		);
		return path;
	};
	return { home, projects, starts, open, seed };
}

test("legacy history archives once, preserves cold transcript and queued data, and has no runtime escape hatch", async (t) => {
	const f = await fixture(t);
	const id = "00000000-0000-4000-8000-000000000001";
	const pending = [{ type: "input", requestId: "watch-notice:old", content: "Never replay", mode: "followUp" }];
	const path = await f.seed(id, { control: true, mode: "ask", pinned: true, working: true, pending });
	const owned = await openSessionStorage(join(f.home, "sessions", id, "durable"));
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const conversation = await harness.root(context);
		await conversation.commit(async (tx) => {
			await tx.appendEntry(conversation.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "Keep this conversation", timestamp: 1 }],
			});
		}, context);
	} finally {
		await harness.close(context);
		owned.release();
	}
	const sessions = await f.open();
	assert.deepEqual(f.starts, []);
	assert.equal(sessions.get(id)?.working, false);
	assert.ok(sessions.get(id)?.archivedAt);
	const saved = JSON.parse(await readFile(path, "utf8"));
	assert.equal(saved.pinned, undefined);
	assert.deepEqual(saved.pending, pending);
	assert.ok(
		JSON.stringify((await sessions.history(id, Number.MAX_SAFE_INTEGER, 40)).entries).includes(
			"Keep this conversation",
		),
	);
	for (const mutate of [
		() => sessions.send(id, "No"),
		() => sessions.restore(id),
		() => sessions.stop(id),
		() => sessions.compact(id),
	])
		await assert.rejects(mutate(), /read-only/);
	const before = await readFile(path, "utf8");
	await sessions.shutdown();
	const restarted = await f.open();
	assert.equal(restarted.get(id)?.archivedAt, saved.archivedAt);
	assert.equal(await readFile(path, "utf8"), before);
	assert.deepEqual(f.starts, []);
});

test("previously admitted chat permissions migrate without widening access or exposing an upgrade", async (t) => {
	const f = await fixture(t);
	const id = "11111111-1111-4111-8111-111111111111";
	const permission = { authorizationId: "old-grant", level: "investigate" };
	const path = await f.seed(id, { mode: "ask", controlPermission: permission });
	await f.open();
	const saved = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(saved.executionPermission, permission);
	assert.equal(saved.controlPermission, undefined);
	assert.deepEqual(f.starts, []);
});

test("invalid or conflicting legacy permissions fail closed instead of becoming unrestricted Build", async (t) => {
	const f = await fixture(t);
	const id = "22222222-2222-4222-8222-222222222222";
	await f.seed(id, {
		mode: "build",
		initializing: true,
		model: "test/model",
		controlPermission: { authorizationId: "old", level: "investigate" },
		executionPermission: { authorizationId: "new", level: "implement" },
	});
	const invalid = "33333333-3333-4333-8333-333333333333";
	await f.seed(invalid, {
		mode: "build",
		initializing: true,
		model: "test/model",
		controlPermission: { authorizationId: "bad", level: "admin" },
	});
	const manager = await f.open();
	assert.equal(manager.get(id), undefined);
	assert.equal(manager.get(invalid), undefined);
	assert.deepEqual(f.starts, []);
});

test("retired HTTP surfaces are absent, not disabled feature implementations", async (t) => {
	const f = await fixture(t);
	const sessions = await f.open();
	const terminals = new TerminalManager();
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		sessions,
		f.projects,
		new ModelCatalog(f.home),
		terminals,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.shutdown();
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	for (const path of ["/control-chat", "/control-chat/dashboard", "/control-chat/memory/view", "/control-hosts/old"])
		for (const method of ["GET", "POST"]) assert.equal((await fetch(base + path, { method })).status, 404);
	assert.deepEqual(sessions.list(), []);
	assert.deepEqual(f.starts, []);
});
