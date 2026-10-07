// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without launching a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import type { SessionState, SessionSummary, SessionUsage } from "@pilot/protocol";
import { Conflict, NotFound, ServiceUnavailable } from "./errors.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { CommandRejected, SessionManager, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

type Command = Extract<KernelCommand, { requestId: string }>;
const first = "provider/first";
const second = "other/second";
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

class FakeWorker implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	busy = false;
	usage: SessionUsage = {
		context: { tokens: 5, contextWindow: 100, percent: 5 },
		subscription: { fetchedAt: 100, windows: [] },
	};
	readonly commands: Command[] = [];
	rejectBusy = false;
	gate?: Promise<void>;
	constructor(private readonly onPacket: (packet: KernelPacket) => void) {}
	send(): void {}
	async request(command: Command): Promise<void> {
		this.commands.push(command);
		await this.gate;
		if (command.type === "changeModel") {
			if (this.rejectBusy) throw new CommandRejected("Conversation is busy", "busy");
			this.usage = { context: { tokens: 5, contextWindow: 200, percent: 2.5 } };
			this.onPacket({
				type: "modelChanged",
				requestId: command.requestId,
				model: command.model,
				thinking: command.thinking ?? "low",
				usage: this.usage,
			});
		}
	}
	async close(): Promise<void> {}
}

async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-session-model-"));
	const id = randomUUID();
	const dir = join(home, "sessions", id);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify({ id, cwd: home, title: "Chat", createdAt: 100, updatedAt: 200, model: first }),
	);
	const projects = new ProjectStore(home);
	const workers: FakeWorker[] = [];
	const sessions = new SessionManager(home, projects, undefined, {
		worker: (_spec, onPacket) => {
			const worker = new FakeWorker(onPacket);
			workers.push(worker);
			queueMicrotask(() => onPacket({ type: "ready", model: first, working: false, usage: worker.usage }));
			return worker;
		},
	});
	await sessions.load();
	const models = new ModelCatalog("/unused");
	const list = t.mock.method(models, "list", async () => ({
		models: [{ id: second, provider: "other", name: "Second", thinkingLevels: ["off", "low", "high"] }],
	}));
	t.after(async () => {
		await sessions.shutdown();
		await Promise.allSettled(sessions["saving"].values());
		await rm(home, { recursive: true, force: true });
	});
	return { home, dir, id, projects, sessions, workers, models, list };
}

test("idle parked session switches through the kernel, persists metadata, publishes summary and usage", async (t) => {
	const f = await fixture(t);
	const changes: SessionSummary[] = [];
	f.sessions.onChange((session) => changes.push(session));
	const changed = await f.sessions.changeModel(f.id, ` ${second} `, f.models);
	assert.equal(changed.model, second);
	assert.equal(changed.thinking, "low");
	assert.equal(changed.state, "idle");
	assert.equal(changed.usage?.subscription, undefined);
	assert.equal(changed.usage?.context?.contextWindow, 200);
	assert.ok(changed.updatedAt > 200);
	assert.deepEqual(changes.at(-1), changed);
	assert.deepEqual(f.list.mock.calls[0]?.arguments, [f.home]);
	assert.equal(f.workers[0]!.commands[0]?.type, "changeModel");
	const stored = JSON.parse(await readFile(join(f.dir, "meta.json"), "utf8"));
	assert.equal(stored.model, second);
	assert.equal(stored.thinking, "low");
	assert.equal(stored.usage, undefined, "provider subscription is ephemeral");
	const reopened = new SessionManager(f.home, f.projects);
	await reopened.load();
	assert.equal(reopened.get(f.id)?.model, second);
	assert.equal(reopened.get(f.id)?.thinking, "low");
	assert.equal(reopened.get(f.id)?.usage, undefined);
	await reopened.shutdown();
});

test("busy, starting, queued, archived and in-flight admissions reject rather than interrupting work", async (t) => {
	const f = await fixture(t);
	const meta = f.sessions["metas"].get(f.id)!;
	for (const patch of [
		{ working: true },
		{ initializing: true },
		{ preparing: { source: f.home, branch: "preparing" } },
		{ pending: [{ type: "input" as const, requestId: "queued", content: "Queued", mode: "followUp" as const }] },
		{ archivedAt: 123 },
	]) {
		Object.assign(meta, patch);
		await assert.rejects(f.sessions.changeModel(f.id, second, f.models), Conflict);
		await assert.rejects(f.sessions.changeModel(f.id, second, f.models, "high"), Conflict);
		for (const key of Object.keys(patch)) delete (meta as unknown as Record<string, unknown>)[key];
	}
	f.sessions["sending"].set(f.id, 1);
	await assert.rejects(f.sessions.changeModel(f.id, second, f.models), Conflict);
	f.sessions["sending"].delete(f.id);
	f.sessions["starting"].set(f.id, Promise.resolve(new Map()));
	await assert.rejects(f.sessions.changeModel(f.id, second, f.models), Conflict);
	f.sessions["starting"].delete(f.id);
	const worker = new FakeWorker(() => {});
	f.sessions["workers"].set(f.id, worker);
	for (const state of ["starting", "working", "failed"] as const) {
		worker.state = state;
		await assert.rejects(f.sessions.changeModel(f.id, second, f.models), Conflict);
	}
	worker.state = "idle";
	worker.busy = true;
	await assert.rejects(f.sessions.changeModel(f.id, second, f.models), Conflict);
	assert.equal(worker.commands.length, 0);
	assert.equal(f.list.mock.callCount(), 0, "reject before catalog lookup or worker work");
	assert.equal(meta.model, first);
});

test("model lookup and acknowledgement hold update and per-session admission gates", async (t) => {
	const f = await fixture(t);
	const lookup = deferred();
	f.list.mock.mockImplementation(async () => {
		await lookup.promise;
		return { models: [{ id: second, provider: "other", name: "Second" }] };
	});
	const change = f.sessions.changeModel(f.id, second, f.models);
	assert.deepEqual(f.sessions.prepareUpdate(), { ready: false });
	await assert.rejects(f.sessions.send(f.id, "racing input"), Conflict);
	await assert.rejects(f.sessions.stop(f.id), Conflict);
	await assert.rejects(f.sessions.editQueuedMessage(f.id, 1, "racing edit"), Conflict);
	await assert.rejects(f.sessions.archive(f.id), Conflict);
	await assert.rejects(f.sessions.changeModel(f.id, second, f.models), Conflict);
	assert.equal(f.sessions["metas"].get(f.id)!.pending, undefined);
	lookup.resolve();
	await change;
	const ack = deferred();
	f.workers[0]!.gate = ack.promise;
	const again = f.sessions.changeModel(f.id, second, f.models);
	assert.deepEqual(f.sessions.prepareUpdate(), { ready: false });
	await assert.rejects(f.sessions.send(f.id, "still blocked"), Conflict);
	ack.resolve();
	await again;
	assert.deepEqual(f.sessions.prepareUpdate(), { ready: true });
	await assert.rejects(f.sessions.changeModel(f.id, second, f.models), ServiceUnavailable);
});

test("unavailable choices never open a worker; durable busy rejections become conflicts", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.sessions.changeModel(f.id, "other/missing", f.models), /not available/);
	assert.equal(f.workers.length, 0);
	assert.equal(f.sessions.get(f.id)?.model, first);
	await assert.rejects(f.sessions.changeModel("missing", second, f.models), NotFound);
	const worker = new FakeWorker(() => {});
	worker.rejectBusy = true;
	f.sessions["workers"].set(f.id, worker);
	await assert.rejects(f.sessions.changeModel(f.id, second, f.models), Conflict);
	assert.equal(f.sessions.get(f.id)?.model, first);
});

test("model HTTP route returns SessionSummary and validates payload, availability, state and origin", async (t) => {
	const f = await fixture(t);
	const server = createDaemonServer(
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		f.models,
		new TerminalManager(),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${f.id}/model`;
	const request = (body: unknown, extra: RequestInit = {}) =>
		fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			...extra,
		});
	const changed = await request({ model: second, thinking: "high" });
	assert.equal(changed.status, 200);
	const summary = (await changed.json()) as SessionSummary;
	assert.equal(summary.id, f.id);
	assert.equal(summary.model, second);
	assert.equal(summary.thinking, "high");
	assert.equal((f.workers[0]!.commands[0] as Extract<Command, { type: "changeModel" }>).thinking, "high");
	assert.equal(summary.usage?.subscription, undefined);
	for (const body of [
		null,
		[],
		{},
		{ model: 42 },
		{ model: " " },
		{ model: "unavailable/model" },
		{ model: second, thinking: null },
		{ model: second, thinking: 42 },
		{ model: second, thinking: "" },
		{ model: second, thinking: "max" },
		{ model: second, thinking: "unknown" },
	]) {
		const rejected = await request(body);
		assert.equal(rejected.status, 400);
		await rejected.arrayBuffer();
	}
	f.workers[0]!.busy = true;
	assert.equal((await request({ model: second })).status, 409);
	assert.equal((await request({ model: second, thinking: "low" })).status, 409);
	f.workers[0]!.busy = false;
	await f.sessions.archive(f.id);
	assert.equal((await request({ model: second })).status, 409);
	assert.equal((await request({ model: second, thinking: "low" })).status, 409);
	await f.sessions.restore(f.id);
	assert.equal(
		(
			await request(
				{ model: second },
				{ headers: { "content-type": "application/json", origin: "https://example.com" } },
			)
		).status,
		403,
	);
	assert.equal((await request({ model: second }, { method: "PATCH" })).status, 404);
	assert.deepEqual(f.sessions.prepareUpdate(), { ready: true });
	assert.equal((await request({ model: second })).status, 503);
});

test("unsupported thinking choices never open a worker or mutate session metadata", async (t) => {
	const f = await fixture(t);
	for (const level of ["", "unknown", "minimal", "max"])
		await assert.rejects(f.sessions.changeModel(f.id, second, f.models, level), /Thinking level is not supported/);
	assert.equal(f.workers.length, 0);
	assert.equal(f.sessions.get(f.id)?.model, first);
	assert.equal(f.sessions.get(f.id)?.thinking, undefined);
});

test("worker startup publishes the effective thinking level instead of stale creation defaults", async (t) => {
	const f = await fixture(t);
	f.sessions["metas"].get(f.id)!.thinking = "high";
	const worker = new FakeWorker(() => {});
	f.sessions["workers"].set(f.id, worker);
	f.sessions["onPacket"](f.sessions["metas"].get(f.id)!, worker, {
		type: "ready",
		model: first,
		thinking: "off",
		working: false,
		usage: {},
	});
	assert.equal(f.sessions.get(f.id)?.thinking, "off");
});
