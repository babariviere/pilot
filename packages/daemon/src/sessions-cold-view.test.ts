// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access tests private cache bounds.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { KernelCommand, PersistedSessionView } from "@pilot/kernel";
import type { AgentEvent } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { type SessionFactories, SessionManager, type SessionWorker } from "./sessions.ts";
import { AttentionDoc } from "../../kernel/src/attention.ts";
import { openSessionStorage } from "../../kernel/src/storage.ts";

const cold: AgentEvent = {
	type: "snapshot",
	entries: [],
	tools: [],
	compactions: [],
	inbox: [],
	agent: { instructions: "persisted" },
	usage: { models: {}, tools: {} },
};
const live: AgentEvent = { ...cold, agent: { instructions: "live replacement" } };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** Exercise manager accounting deterministically; reader admission/cancellation has real-worker tests. */
function controlledReads(t: TestContext, manager: SessionManager) {
	const reads: (ReturnType<typeof deferred<PersistedSessionView & { bytes: number }>> & { queued: boolean })[] = [];
	const finish = (index: number) => {
		reads[index].queued = false;
		reads[index].resolve({ events: [cold], bytes: 1 });
	};
	t.mock.method(manager["coldReader"], "read", () => {
		const read = { ...deferred<PersistedSessionView & { bytes: number }>(), queued: true };
		reads.push(read);
		const shutdown = () => read.resolve({ events: [cold], bytes: 1 });
		manager["shutdownSignal"].signal.addEventListener("abort", shutdown, { once: true });
		void read.promise.then(shutdownCleanup, shutdownCleanup);
		function shutdownCleanup() {
			manager["shutdownSignal"].signal.removeEventListener("abort", shutdown);
		}
		return read.promise;
	});
	t.mock.method(manager["coldReader"], "cancel", (promise: Promise<PersistedSessionView>) => {
		const read = reads.find((read) => read.promise === promise);
		if (!read?.queued) return false;
		read.queued = false;
		read.reject(new DOMException("Session snapshot read cancelled", "AbortError"));
		return true;
	});
	return { reads, finish };
}

async function until(check: () => boolean) {
	const deadline = Date.now() + 15_000;
	while (!check()) {
		assert.ok(Date.now() < deadline, "condition did not settle");
		await delay(1);
	}
}

async function fixture(t: TestContext, extra: Record<string, unknown> = {}, snapshot?: SessionFactories["snapshot"]) {
	const home = await mkdtemp(join(tmpdir(), "pilot-cold-view-"));
	const id = randomUUID();
	const dir = join(home, "sessions", id);
	await mkdir(dir, { recursive: true });
	const file = join(dir, "meta.json");
	await writeFile(
		file,
		JSON.stringify({ id, cwd: home, title: "Cold session", createdAt: Date.now(), updatedAt: Date.now(), ...extra }),
	);
	const workers: (SessionWorker & { sent: KernelCommand[] })[] = [];
	const managers: SessionManager[] = [];
	const worker: SessionFactories["worker"] = (_spec, onPacket, onExit) => {
		const value: SessionWorker & { sent: KernelCommand[] } = {
			ready: Promise.resolve(),
			state: "idle",
			busy: false,
			sent: [],
			send(command) {
				this.sent.push(command);
				if (command.type === "watch") onPacket({ type: "events", watchId: command.watchId, events: [live] });
			},
			async request(command) {
				if (command.type === "input") this.state = "working";
				else if (command.type === "abort") this.state = "idle";
				onPacket({ type: "working", working: this.state === "working" });
			},
			async close() {
				onExit(this, 0);
			},
			async hasChildren() {
				return false;
			},
		};
		workers.push(value);
		return value;
	};
	const open = async () => {
		const manager = new SessionManager(
			home,
			new ProjectStore(home),
			undefined,
			{ worker, ...(snapshot ? { snapshot } : {}) },
			{},
			{ idleParkMs: Number.POSITIVE_INFINITY },
		);
		managers.push(manager);
		await manager.load();
		return manager;
	};
	t.after(async () => {
		await Promise.all(managers.map((manager) => manager.shutdown()));
		await rm(home, { recursive: true, force: true });
	});
	return { id, home, file, workers, open };
}

test("cold viewing after daemon restart never starts a worker, then receives a fresh live replacement on send", async (t) => {
	let reads = 0;
	const f = await fixture(t, {}, async (_directory, _cwd, includeTodos) => {
		assert.equal(includeTodos, true, "legacy Build cold views retain TODO reads");
		reads++;
		return { events: [cold] };
	});
	const first = await f.open();
	await first.shutdown();
	const manager = await f.open();
	const before = await readFile(f.file, "utf8");
	const batches: AgentEvent[][] = [];
	const off = manager.subscribe(f.id, (events) => batches.push(events));
	await until(() => batches.length === 1);
	assert.deepEqual(batches[0], [cold]);
	assert.equal(f.workers.length, 0);
	assert.equal(manager.get(f.id)?.state, "parked");
	assert.equal(await readFile(f.file, "utf8"), before, "viewing is not activity or a metadata write");
	await manager.send(f.id, "new input");
	assert.deepEqual(batches[1], [live]);
	assert.equal(f.workers.length, 1);
	off();
	assert.equal(f.workers[0]?.sent.at(-1)?.type, "unwatch");
	assert.equal(reads, 1);
});

test("daemon restart loads actual persisted history and attention without the worker or native SDK", async (t) => {
	const f = await fixture(t);
	const owned = await openSessionStorage(join(f.home, "sessions", f.id, "durable"));
	const harness = await Harness.open(owned.storage, { models: createModels(), registry: createRegistry() }, context);
	try {
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			const entry = await tx.appendEntry(root.id, { kind: "test.persisted", data: { text: "survives restart" } });
			(await tx.doc(AttentionDoc, root.id)).completion = {
				input: 999,
				entry: entry.id,
				outcome: "needs_input",
				outcomeAt: 1234,
				outcomeReason: "approval",
			};
		}, context);
	} finally {
		await harness.close(context);
		owned.release();
	}
	const first = await f.open();
	await first.shutdown();
	const manager = await f.open();
	const batches: AgentEvent[][] = [];
	manager.subscribe(f.id, (events) => batches.push(events));
	await until(() => batches.length === 1);
	const snapshot = batches[0]![0]!;
	assert.equal(snapshot.type, "snapshot");
	if (snapshot.type === "snapshot") assert.deepEqual(snapshot.entries[0]?.data, { text: "survives restart" });
	assert.equal(f.workers.length, 0);
	assert.equal(manager.get(f.id)?.state, "parked");
	assert.equal(manager.get(f.id)?.outcome, "needs_input");
	assert.equal(manager.get(f.id)?.outcomeAt, 1234);
});

test("a delayed cold read cannot replace a started worker's snapshot, even after that worker exits", async (t) => {
	const gate = deferred<PersistedSessionView>();
	const f = await fixture(t, {}, () => gate.promise);
	const manager = await f.open();
	const batches: AgentEvent[][] = [];
	manager.subscribe(f.id, (events) => batches.push(events));
	await manager.send(f.id, "new input");
	await f.workers[0]!.close();
	gate.resolve({ events: [cold] });
	await delay(10);
	assert.deepEqual(batches, [[live]]);
});

test("unsubscribe while cold reading prevents delivery and later live attachment", async (t) => {
	const gate = deferred<PersistedSessionView>();
	const f = await fixture(t, {}, () => gate.promise);
	const manager = await f.open();
	const off = manager.subscribe(f.id, () => assert.fail("unsubscribed listener called"));
	off();
	gate.resolve({ events: [cold] });
	await manager.send(f.id, "new input");
	assert.equal(f.workers[0]!.sent.filter((command) => command.type === "watch").length, 0);
});

test("shared queued cold reads survive one viewer leaving and cache eviction", async (t) => {
	const f = await fixture(t);
	const manager = await f.open();
	const { reads, finish } = controlledReads(t, manager);
	const first = manager.subscribe(f.id, () => assert.fail("departed viewer received history"));
	const second = manager.subscribe(f.id, () => assert.fail("departed viewer received history"));
	const shared = manager["coldLoading"].get(f.id)!;
	assert.equal(reads.length, 1);
	assert.equal(manager["coldConsumers"].get(shared), 2);
	first();
	first();
	assert.equal(reads[0].queued, true, "idempotent departure cannot cancel another viewer's read");
	manager["coldSnapshots"].delete(f.id);
	const batches: AgentEvent[][] = [];
	const third = manager.subscribe(f.id, (events) => batches.push(events));
	t.after(third);
	assert.equal(manager["coldLoading"].get(f.id), shared, "loading dedup survives settled-cache eviction");
	assert.equal(manager["coldConsumers"].get(shared), 2);
	second();
	assert.equal(reads.length, 1);
	assert.equal(reads[0].queued, true);
	finish(0);
	await until(() => batches.length === 1 && manager["coldConsumers"].size === 0);
	assert.ok(batches[0]!.some((event) => event.type === "snapshot"));
	assert.equal(f.workers.length, 0);
});

test("last cold viewer cancels queued work and immediate resubscription creates a fresh shared flight", async (t) => {
	const f = await fixture(t);
	const manager = await f.open();
	const { reads, finish } = controlledReads(t, manager);
	const warnings = t.mock.method(console, "warn", () => {});
	const first = manager.subscribe(f.id, () => assert.fail("cancelled viewer received history"));
	const second = manager.subscribe(f.id, () => assert.fail("cancelled viewer received history"));
	const cancelled = manager["coldLoading"].get(f.id)!;
	first();
	assert.equal(reads[0].queued, true);
	second();
	assert.equal(reads[0].queued, false);
	assert.equal(manager["coldLoading"].has(f.id), false);
	assert.equal(manager["coldSnapshots"].has(f.id), false);
	assert.equal(manager["coldConsumers"].size, 0);
	const batches: AgentEvent[][] = [];
	const off = manager.subscribe(f.id, (events) => batches.push(events));
	t.after(off);
	const fresh = manager["coldLoading"].get(f.id)!;
	assert.notEqual(fresh, cancelled);
	assert.equal(reads.length, 2);
	assert.equal(reads[1].queued, true);
	await assert.rejects(cancelled, { name: "AbortError" });
	assert.equal(manager["coldLoading"].get(f.id), fresh);
	finish(1);
	await until(() => batches.length === 1 && manager["coldReads"].size === 0 && manager["coldConsumers"].size === 0);
	assert.equal(manager["coldSnapshots"].get(f.id)?.promise, fresh, "old settlement cannot evict the new read");
	assert.equal(warnings.mock.callCount(), 0, "expected queued cancellation is silent");
	assert.equal(f.workers.length, 0);
});

test("departing cold viewers leave started reads cacheable and a new viewer shares the active flight", async (t) => {
	const f = await fixture(t);
	const manager = await f.open();
	const { reads, finish } = controlledReads(t, manager);
	const first = manager.subscribe(f.id, () => assert.fail("departed viewer received history"));
	const second = manager.subscribe(f.id, () => assert.fail("departed viewer received history"));
	const active = manager["coldLoading"].get(f.id)!;
	assert.equal(reads.length, 1);
	reads[0].queued = false;
	first();
	second();
	assert.equal(manager["coldLoading"].get(f.id), active, "started reads are not cancelled");
	assert.equal(manager["coldConsumers"].size, 0);
	const batches: AgentEvent[][] = [];
	const off = manager.subscribe(f.id, (events) => batches.push(events));
	t.after(off);
	assert.equal(manager["coldLoading"].get(f.id), active);
	assert.equal(reads.length, 1);
	finish(0);
	await until(() => batches.length === 1 && manager["coldConsumers"].size === 0);
	assert.equal(manager["coldSnapshots"].get(f.id)?.promise, active);
	assert.equal(f.workers.length, 0);
});

test("failed, cancelled preparation, update lease and archived guards do not wake cold sessions", async (t) => {
	for (const extra of [
		{ failure: "startup failed" },
		{ preparing: { source: "/unused" }, cancelled: true },
		{ archivedAt: Date.now(), pending: [{ type: "input", requestId: "old", content: "old", mode: "followUp" }] },
	]) {
		const f = await fixture(t, extra);
		const manager = await f.open();
		const batches: AgentEvent[][] = [];
		manager.subscribe(f.id, (events) => batches.push(events));
		await until(() => batches.length > 0);
		assert.equal(f.workers.length, 0);
	}
	const f = await fixture(t);
	const manager = await f.open();
	assert.deepEqual(manager.prepareUpdate(), { ready: true });
	assert.throws(() => manager.subscribe(f.id, () => {}), /preparing for an update/);
	assert.equal(f.workers.length, 0);
});

test("cold snapshot cache bounds count and bytes, expires external edits, and invalidates on execution", async (t) => {
	let reads = 0;
	let bytes = 1;
	const f = await fixture(t, {}, async () => {
		reads++;
		return { events: [cold], bytes };
	});
	const manager = await f.open();
	const meta = manager["metas"].get(f.id)!;
	for (let index = 0; index < 30; index++) await manager["coldSnapshot"]({ ...meta, id: randomUUID() });
	assert.equal(manager["coldSnapshots"].size, 16);
	bytes = 9 * 1024 * 1024;
	await manager["coldSnapshot"](meta);
	await manager["coldSnapshot"]({ ...meta, id: randomUUID() });
	assert.ok([...manager["coldSnapshots"].values()].reduce((sum, entry) => sum + entry.bytes, 0) <= 16 * 1024 * 1024);
	const now = Date.now();
	t.mock.method(Date, "now", () => now + 5_001);
	const before = reads;
	await manager["coldSnapshot"](meta);
	assert.equal(reads, before + 1, "TTL forces a fresh persisted/TODO read");
	await manager.send(f.id, "work invalidates cached snapshot");
	assert.equal(manager["coldSnapshots"].has(f.id), false);
});
